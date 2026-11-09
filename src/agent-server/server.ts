import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  commandResponse,
  matchesEventFilter,
  parseEventFilter,
  parseProtocolCommand,
  protocolErrorResponse,
  ProtocolRequestError,
  toProtocolEvent,
} from "./protocol.ts";
import { validateAgentDescriptor } from "./catalog.ts";
import { AgentCommandError } from "./types.ts";
import type {
  AgentCatalog,
  AgentServer,
  AgentServerOptions,
  EventStreamFilter,
  HostedAgent,
  HostedAgentEvent,
  ThreadPage,
  ThreadRecord,
  ThreadStatus,
} from "./types.ts";

interface CachedCommand {
  fingerprint: string;
  response: Record<string, unknown>;
}

interface PersistedState {
  version: 1;
  threads: ThreadRecord[];
  commands: Record<string, Record<string, CachedCommand>>;
  eventSeqs?: Record<string, number>;
}

interface EventEnvelope {
  seq: number;
  event: HostedAgentEvent;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code = "invalid_request") {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  readonly #capacity: number;
  #ended = false;

  constructor(capacity = 128) { this.#capacity = capacity; }

  push(item: T): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else if (this.#items.length >= this.#capacity) this.close();
    else this.#items.push(item);
  }

  close(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.#items.length) {
        yield this.#items.shift()!;
        continue;
      }
      if (this.#ended) return;
      const next = await new Promise<IteratorResult<T>>((resolveNext) => this.#waiters.push(resolveNext));
      if (next.done) return;
      yield next.value;
    }
  }
}

function sanitizeThread(thread: ThreadRecord): Omit<ThreadRecord, "adapterRef"> {
  const { adapterRef: _adapterRef, ...publicThread } = thread;
  return structuredClone(publicThread);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function pendingInputKey(namespace: readonly string[], interruptId: string): string {
  return JSON.stringify([namespace, interruptId]);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function equalSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseBearer(value: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(value ?? "");
  return match?.[1];
}

function waitForDrain(response: ServerResponse): Promise<boolean> {
  if (response.destroyed || response.writableEnded) return Promise.resolve(false);
  return new Promise((resolveDrain) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onClose);
    };
    const onDrain = () => { cleanup(); resolveDrain(true); };
    const onClose = () => { cleanup(); resolveDrain(false); };
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onClose);
  });
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readJson(request: IncomingMessage, maxBytes = 1_048_576): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBytes) throw new HttpError(413, "Request body is too large.");
    chunks.push(buffer);
  }
  if (length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function cursorFor(thread: ThreadRecord): string {
  return Buffer.from(`${thread.createdAt}\n${thread.threadId}`).toString("base64url");
}

function parseCursor(cursor: string): { createdAt: number; threadId: string } {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8").split("\n");
    const createdAt = Number(decoded[0]);
    const threadId = decoded[1];
    if (!Number.isFinite(createdAt) || !threadId) throw new Error();
    return { createdAt, threadId };
  } catch {
    throw new HttpError(400, "Invalid pagination cursor.");
  }
}

function normalizeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "metadata must be an object.");
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "metadata must contain only JSON-serializable values.");
  }
}

export class AgentServerRuntime implements AgentServer {
  readonly #agents: ReadonlyMap<string, HostedAgent>;
  readonly #token: string;
  readonly #host: string;
  readonly #port: number;
  readonly #statePath: string;
  readonly #lockPath: string;
  readonly #maxConcurrentThreads: number;
  readonly #trustProxy: boolean;
  readonly #trustedProxyAddresses: Set<string>;
  readonly #state: PersistedState = { version: 1, threads: [], commands: {}, eventSeqs: {} };
  readonly #threadMap = new Map<string, ThreadRecord>();
  readonly #events = new Map<string, EventEnvelope[]>();
  readonly #eventSeq = new Map<string, number>();
  readonly #subscribers = new Map<string, Set<AsyncQueue<EventEnvelope>>>();
  readonly #pumps = new Map<string, Promise<void>>();
  readonly #restartPumps = new Set<string>();
  readonly #activeThreads = new Set<string>();
  readonly #threadLocks = new Map<string, Promise<void>>();
  #server: Server | undefined;
  #persistQueue: Promise<void> = Promise.resolve();
  #ownsLock = false;
  #closing = false;

  constructor(options: AgentServerOptions) {
    if (!options.token || options.token.length < 16) throw new Error("Agent server bearer token must contain at least 16 characters.");
    for (const agent of options.agents) validateAgentDescriptor(agent.descriptor, agent.descriptor.id);
    this.#agents = new Map(options.agents.map((agent) => [agent.descriptor.id, agent]));
    if (this.#agents.size !== options.agents.length || this.#agents.size === 0) throw new Error("Agent server requires a non-empty catalog with unique IDs.");
    this.#token = options.token;
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port ?? 3000;
    this.#statePath = resolve(options.statePath ?? ".agent-server/server-state.json");
    this.#lockPath = `${this.#statePath}.lock`;
    this.#maxConcurrentThreads = options.maxConcurrentThreads ?? 4;
    this.#trustProxy = options.trustProxy ?? false;
    this.#trustedProxyAddresses = new Set((options.trustedProxyAddresses ?? []).map((address) => address.toLowerCase()));
    if (!Number.isSafeInteger(this.#port) || this.#port < 0 || this.#port > 65535) throw new Error("port must be an integer between 0 and 65535.");
    if (!Number.isSafeInteger(this.#maxConcurrentThreads) || this.#maxConcurrentThreads < 1) throw new Error("maxConcurrentThreads must be a positive integer.");
    if (!isLoopback(this.#host) && (!this.#trustProxy || this.#trustedProxyAddresses.size === 0)) {
      throw new Error("Non-loopback binds require trustProxy=true and at least one trustedProxyAddresses entry for a TLS-terminating reverse proxy.");
    }
  }

  async listen(): Promise<{ host: string; port: number }> {
    if (this.#server) return this.address()!;
    await mkdir(dirname(this.#statePath), { recursive: true });
    await this.#acquireLock();

    try {
      await this.#loadState();
      for (const [agentId, agent] of this.#agents) {
        try { await agent.initialize(); }
        catch (error) {
          throw new Error(`Failed to initialize configured agent "${agentId}": ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
      }
      for (const thread of this.#threadMap.values()) {
        const agent = this.#agents.get(thread.agentId);
        if (!agent) throw new Error(`Saved thread "${thread.threadId}" references missing agent "${thread.agentId}".`);
        const ref = await agent.createThread({
          threadId: thread.threadId,
          agentId: thread.agentId,
          ...(thread.metadata ? { metadata: thread.metadata } : {}),
          ...(thread.adapterRef !== undefined ? { adapterRef: thread.adapterRef } : {}),
        });
        if (thread.adapterRef === undefined && ref !== undefined) thread.adapterRef = ref;
      }
      for (const thread of this.#threadMap.values()) {
        try { await this.#reconcileThread(thread.threadId); }
        catch (error) {
          throw new Error(`Failed to recover thread "${thread.threadId}" for agent "${thread.agentId}": ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
      }
      await this.#persist();
      this.#server = createServer((request, response) => { void this.#handleHttp(request, response); });
      await new Promise<void>((resolveListen, reject) => {
        const server = this.#server!;
        const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
        const onListening = () => { server.off("error", onError); resolveListen(); };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.#port, this.#host);
      });
      return this.address()!;
    } catch (error) {
      await Promise.all([...this.#agents.values()].map((agent) => agent.close().catch(() => {})));
      await Promise.all([...this.#pumps.values()].map((pump) => pump.catch(() => {})));
      await this.#releaseLock();
      throw error;
    }
  }

  address(): { host: string; port: number } | undefined {
    const address = this.#server?.address();
    if (!address || typeof address === "string") return undefined;
    return { host: address.address, port: address.port };
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    for (const subscribers of this.#subscribers.values()) for (const subscriber of subscribers) subscriber.close();
    const failures: unknown[] = [];
    try {
      if (this.#server?.listening) {
        await new Promise<void>((resolveClose, reject) => {
          this.#server!.close((error) => error ? reject(error) : resolveClose());
          this.#server!.closeAllConnections();
        });
      }
    } catch (error) { failures.push(error); }
    try {
      const cleanup = await Promise.allSettled([
        ...[...this.#agents.values()].map((agent) => agent.close()),
        ...[...this.#pumps.values()],
        this.#persistQueue,
      ]);
      failures.push(...cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason));
    } finally {
      await this.#releaseLock();
    }
    if (failures.length) throw new AggregateError(failures, "Agent server shutdown encountered errors.");
  }

  async #acquireLock(): Promise<void> {
    const create = () => writeFile(this.#lockPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
    try {
      await create();
      this.#ownsLock = true;
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let owner = Number.NaN;
    try { owner = Number((await readFile(this.#lockPath, "utf8")).trim()); } catch {}
    if (Number.isSafeInteger(owner) && owner > 0) {
      try {
        process.kill(owner, 0);
        throw new Error(`Another server process (PID ${owner}) owns the local data directory (lock: ${this.#lockPath}).`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await unlink(this.#lockPath).catch(() => {});
    try { await create(); this.#ownsLock = true; } catch (error) {
      throw new Error(`Another server may own the local data directory (lock: ${this.#lockPath}).`, { cause: error });
    }
  }

  async #releaseLock(): Promise<void> {
    if (!this.#ownsLock) return;
    this.#ownsLock = false;
    await unlink(this.#lockPath).catch(() => {});
  }

  async #loadState(): Promise<void> {
    let decoded: unknown;
    try {
      decoded = JSON.parse(await readFile(this.#statePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`Could not read agent server state "${this.#statePath}": ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (!decoded || typeof decoded !== "object" || (decoded as PersistedState).version !== 1
      || !Array.isArray((decoded as PersistedState).threads) || typeof (decoded as PersistedState).commands !== "object") {
      throw new Error(`Agent server state "${this.#statePath}" has an unsupported or invalid format.`);
    }
    const loaded = decoded as PersistedState;
    this.#state.threads = loaded.threads;
    this.#state.commands = loaded.commands ?? {};
    this.#state.eventSeqs = loaded.eventSeqs ?? {};
    for (const [threadId, seq] of Object.entries(this.#state.eventSeqs)) {
      if (Number.isSafeInteger(seq) && seq >= 0) this.#eventSeq.set(threadId, seq);
    }
    for (const thread of this.#state.threads) {
      const savedCursor = this.#eventSeq.get(thread.threadId);
      if (savedCursor !== undefined) thread.eventCursor = savedCursor;
      if (!thread.threadId || !thread.agentId || this.#threadMap.has(thread.threadId)) throw new Error("Agent server state contains an invalid or duplicate thread.");
      this.#threadMap.set(thread.threadId, thread);
    }
  }

  #persist(): Promise<void> {
    const snapshot = JSON.stringify(this.#state, null, 2);
    const next = this.#persistQueue.then(async () => {
      const temporaryPath = `${this.#statePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, snapshot, { encoding: "utf8", flag: "wx" });
        await rename(temporaryPath, this.#statePath);
      } catch (error) {
        await unlink(temporaryPath).catch(() => {});
        throw error;
      }
    });
    this.#persistQueue = next.catch(() => {});
    return next;
  }

  async #withThreadLock<T>(threadId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#threadLocks.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    const queued = previous.then(() => current);
    this.#threadLocks.set(threadId, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.#threadLocks.get(threadId) === queued) this.#threadLocks.delete(threadId);
    }
  }

  async #handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (this.#closing) throw new HttpError(503, "Server is closing.");
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (!url.pathname.startsWith("/v1/")) throw new HttpError(404, "Route not found.", "not_found");
      this.#authorize(request);
      await this.#route(request, response, url);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      if (error instanceof ProtocolRequestError) {
        json(response, error.status, { error: { code: error.code, message: error.message } });
        return;
      }
      if (error instanceof HttpError) {
        json(response, error.status, { error: { code: error.code, message: error.message } });
        return;
      }
      json(response, 500, { error: { code: "internal_error", message: error instanceof Error ? error.message : String(error) } });
    }
  }

  #authorize(request: IncomingMessage): void {
    const auth = parseBearer(request.headers.authorization);
    if (!auth || !equalSecret(auth, this.#token)) throw new HttpError(401, "Bearer token is missing or invalid.", "unauthorized");
    if (!isLoopback(this.#host)) {
      const remote = (request.socket.remoteAddress ?? "").toLowerCase().replace(/^::ffff:/, "");
      if (!this.#trustedProxyAddresses.has(remote)) throw new HttpError(403, "Request did not originate from a configured trusted proxy.", "untrusted_proxy");
      const forwarded = request.headers["x-forwarded-proto"];
      const protocol = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      if (!(request.socket as typeof request.socket & { encrypted?: boolean }).encrypted && protocol?.split(",")[0]?.trim() !== "https") {
        throw new HttpError(400, "Remote access requires HTTPS at a trusted TLS-terminating reverse proxy.", "https_required");
      }
    }
  }

  async #route(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    if (request.method === "GET" && path === "/v1/agents") {
      json(response, 200, { agents: [...this.#agents.values()].map(({ descriptor }) => structuredClone(descriptor)) });
      return;
    }
    const oneAgent = /^\/v1\/agents\/([^/]+)$/.exec(path);
    if (request.method === "GET" && oneAgent) {
      const agent = this.#agents.get(decodeURIComponent(oneAgent[1]!));
      if (!agent) throw new HttpError(404, "Agent not found.", "agent_not_found");
      json(response, 200, structuredClone(agent.descriptor));
      return;
    }
    if (request.method === "POST" && path === "/v1/threads") {
      await this.#createThread(request, response);
      return;
    }
    if (request.method === "GET" && path === "/v1/threads") {
      this.#listThreads(response, url);
      return;
    }
    const oneThread = /^\/v1\/threads\/([^/]+)(?:\/(commands|stream))?$/.exec(path);
    if (oneThread) {
      const threadId = decodeURIComponent(oneThread[1]!);
      const endpoint = oneThread[2];
      if (request.method === "GET" && !endpoint) {
        const thread = this.#threadMap.get(threadId);
        if (!thread) throw new HttpError(404, "Thread not found.", "thread_not_found");
        json(response, 200, sanitizeThread(thread));
        return;
      }
      if (request.method === "POST" && endpoint === "commands") {
        await this.#command(request, response, threadId);
        return;
      }
      if (request.method === "POST" && endpoint === "stream") {
        await this.#stream(request, response, threadId, url);
        return;
      }
    }
    throw new HttpError(404, "Route not found.", "not_found");
  }

  async #createThread(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Request body must be an object.");
    const input = body as Record<string, unknown>;
    const agentId = typeof input.agentId === "string" ? input.agentId : "";
    const agent = this.#agents.get(agentId);
    if (!agent) throw new HttpError(404, `Unknown agent "${agentId}".`, "agent_not_found");
    const ifExists = input.ifExists ?? "error";
    if (ifExists !== "error" && ifExists !== "do_nothing") throw new HttpError(400, 'ifExists must be "error" or "do_nothing".');
    const requestedId = input.threadId;
    const threadId = requestedId === undefined ? randomUUID() : requestedId;
    if (typeof threadId !== "string" || threadId.length < 1 || threadId.length > 200 || !/^[\w.:-]+$/.test(threadId)) {
      throw new HttpError(400, "threadId must contain 1-200 letters, numbers, '.', '_', ':', or '-'.");
    }
    const metadata = normalizeMetadata(input.metadata);

    await this.#withThreadLock(threadId, async () => {
      const existing = this.#threadMap.get(threadId);
      if (existing) {
        if (ifExists !== "do_nothing") throw new HttpError(409, "Thread ID already exists.", "thread_conflict");
        if (existing.agentId !== agentId) throw new HttpError(409, "Thread ID is bound to another agent.", "thread_agent_conflict");
        json(response, 200, sanitizeThread(existing));
        return;
      }
      const createdAt = Date.now();
      const thread: ThreadRecord = {
        threadId,
        agentId,
        ...(metadata ? { metadata } : {}),
        createdAt,
        updatedAt: createdAt,
        status: "idle",
      };
      const adapterRef = await agent.createThread({ threadId, agentId, ...(metadata ? { metadata } : {}) });
      if (adapterRef !== undefined) thread.adapterRef = adapterRef;
      this.#threadMap.set(threadId, thread);
      this.#state.threads.push(thread);
      await this.#persist();
      json(response, 201, sanitizeThread(thread));
    });
  }

  #listThreads(response: ServerResponse, url: URL): void {
    const limitValue = Number(url.searchParams.get("limit") ?? 50);
    if (!Number.isSafeInteger(limitValue) || limitValue < 1 || limitValue > 100) throw new HttpError(400, "limit must be between 1 and 100.");
    const cursorValue = url.searchParams.get("cursor");
    const cursor = cursorValue ? parseCursor(cursorValue) : undefined;
    const threads = this.#state.threads
      .filter((thread) => !cursor || thread.createdAt > cursor.createdAt || (thread.createdAt === cursor.createdAt && thread.threadId > cursor.threadId))
      .sort((a, b) => a.createdAt - b.createdAt || a.threadId.localeCompare(b.threadId));
    const pageThreads = threads.slice(0, limitValue);
    const page: ThreadPage = {
      threads: pageThreads.map(sanitizeThread),
      ...(threads.length > limitValue && pageThreads.length ? { nextCursor: cursorFor(pageThreads.at(-1)!) } : {}),
    };
    json(response, 200, page);
  }

  async #command(request: IncomingMessage, response: ServerResponse, threadId: string): Promise<void> {
    const wire = await readJson(request);
    let parsed;
    try {
      parsed = parseProtocolCommand(wire);
    } catch (error) {
      const candidate = wire && typeof wire === "object" ? (wire as { id?: unknown }).id : undefined;
      const id = Number.isSafeInteger(candidate) && (candidate as number) >= 0 ? candidate as number : null;
      json(response, error instanceof ProtocolRequestError ? error.status : 400, protocolErrorResponse(id, error));
      return;
    }
    const thread = this.#threadMap.get(threadId);
    if (!thread) {
      json(response, 404, protocolErrorResponse(parsed.id, new ProtocolRequestError("Thread not found.", 404, "no_such_run")));
      return;
    }
    const agent = this.#agents.get(thread.agentId)!;
    const fingerprint = canonical(wire);

    const result = await this.#withThreadLock(threadId, async () => {
      const records = this.#state.commands[threadId] ?? (this.#state.commands[threadId] = {});
      const existing = records[parsed.command.commandId];
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          return protocolErrorResponse(parsed.id, new ProtocolRequestError("Command ID was already used with a different request.", 409, "invalid_argument")) as unknown as Record<string, unknown>;
        }
        return existing.response;
      }

      const wasActive = this.#activeThreads.has(threadId);
      let wireResponse: Record<string, unknown>;
      try {
        if (parsed.command.type === "run.start") {
          if (parsed.command.assistantId !== thread.agentId) throw new ProtocolRequestError("assistant_id does not match the thread's bound agent.", 409, "invalid_argument");
          if (thread.status === "running" || thread.status === "awaiting_input") {
            throw new ProtocolRequestError("Thread already has an active or interrupted run.", 409, "invalid_argument");
          }
          if (agent.descriptor.threadPolicy === "single-case" && thread.currentRun) {
            throw new ProtocolRequestError("This agent uses single-case threads; create a new thread for another case.", 409, "invalid_argument");
          }
          if (this.#activeThreads.size >= this.#maxConcurrentThreads) throw new ProtocolRequestError("Server is at its active-thread limit.", 429, "unknown_error");
          this.#activeThreads.add(threadId);
        } else if (parsed.command.type === "input.respond") {
          // Pending-input state belongs to the adapter; host status can lag its durable workflow state.
          if (!this.#activeThreads.has(threadId) && this.#activeThreads.size >= this.#maxConcurrentThreads) {
            throw new ProtocolRequestError("Server is at its active-thread limit.", 429, "unknown_error");
          }
          this.#activeThreads.add(threadId);
        }

        const agentResult = await agent.handleCommand(threadId, parsed.command);
        if (agentResult.runId || parsed.command.type === "run.start" || parsed.command.type === "input.respond") {
          const previousRun = thread.currentRun;
          const runId = agentResult.runId ?? previousRun?.runId ?? threadId;
          const status = agentResult.status ?? (parsed.command.type === "state.get" ? thread.status : "running");
          thread.currentRun = {
            runId,
            status,
            updatedAt: Date.now(),
            ...(agentResult.summary ? { summary: agentResult.summary } : previousRun?.summary ? { summary: previousRun.summary } : {}),
            ...(previousRun?.pendingInputs?.length ? { pendingInputs: previousRun.pendingInputs } : {}),
          };
          if (parsed.command.type === "input.respond") {
            const responseKey = pendingInputKey(parsed.command.namespace, parsed.command.interruptId);
            const pendingInputs = (thread.currentRun.pendingInputs ?? []).filter((pending) =>
              pendingInputKey(pending.namespace, pending.interruptId) !== responseKey);
            if (pendingInputs.length) thread.currentRun.pendingInputs = pendingInputs;
            else delete thread.currentRun.pendingInputs;
          }
          if (status === "completed" || status === "failed") delete thread.currentRun.pendingInputs;
          thread.status = status;
          thread.updatedAt = Date.now();
          if (status === "running") this.#activeThreads.add(threadId);
          else this.#activeThreads.delete(threadId);
        }
        wireResponse = commandResponse(parsed.id, agentResult) as unknown as Record<string, unknown>;
      } catch (error) {
        if (!wasActive) this.#activeThreads.delete(threadId);
        if (!(error instanceof ProtocolRequestError) && !(error instanceof AgentCommandError)) {
          const updatedAt = Date.now();
          thread.status = "failed";
          thread.updatedAt = updatedAt;
          if (parsed.command.type === "run.start" || parsed.command.type === "input.respond") {
            thread.currentRun = {
              runId: thread.currentRun?.runId ?? threadId,
              status: "failed",
              updatedAt,
              summary: { ...(thread.currentRun?.summary ?? {}), admissionError: error instanceof Error ? error.message : String(error) },
            };
          }
        }
        wireResponse = protocolErrorResponse(parsed.id, error) as unknown as Record<string, unknown>;
      }
      if ((wireResponse as { meta?: { retry_safe?: unknown } }).meta?.retry_safe !== true) {
        records[parsed.command.commandId] = { fingerprint, response: wireResponse };
        const recordKeys = Object.keys(records);
        for (const key of recordKeys.slice(0, Math.max(0, recordKeys.length - 1000))) delete records[key];
      }
      await this.#persist();
      return wireResponse;
    });
    const errorCode = (result as { type?: string; error?: string }).error;
    const responseStatus = (result as { meta?: { http_status?: unknown } }).meta?.http_status;
    const status = (result as { type?: string }).type === "error"
      ? typeof responseStatus === "number" ? responseStatus : errorCode === "invalid_argument" ? 409 : errorCode === "no_such_run" ? 404 : errorCode === "not_supported" || errorCode === "unknown_command" ? 501 : errorCode === "unknown_error" ? 500 : 400
      : 200;
    json(response, status, result);
    if (status === 200 || (result as { meta?: { retry_safe?: unknown } }).meta?.retry_safe === false) this.#ensurePump(threadId, true);
  }

  async #stream(request: IncomingMessage, response: ServerResponse, threadId: string, _url: URL): Promise<void> {
    const thread = this.#threadMap.get(threadId);
    if (!thread) throw new HttpError(404, "Thread not found.", "thread_not_found");
    const body = await readJson(request);
    let filter: EventStreamFilter;
    try { filter = parseEventFilter(body); }
    catch (error) {
      if (error instanceof ProtocolRequestError) throw new HttpError(error.status, error.message, error.code);
      throw error;
    }
    const lastEventId = request.headers["last-event-id"];
    const last = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
    if (filter.since === undefined && last && /^\d+$/.test(last)) filter = { ...filter, since: Number(last) };
    if (filter.since !== undefined) {
      const currentCursor = this.#eventSeq.get(threadId) ?? 0;
      if (filter.since > currentCursor) throw new HttpError(400, "Event cursor is ahead of this thread.", "invalid_cursor");
      const retained = this.#events.get(threadId) ?? [];
      if (filter.since < currentCursor && (!retained.length || filter.since < retained[0]!.seq - 1)) {
        throw new HttpError(409, `Event cursor expired; read the thread/state snapshot and reconnect from cursor ${currentCursor}.`, "cursor_expired");
      }
    }
    this.#ensurePump(threadId);
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.flushHeaders();

    const queue = new AsyncQueue<EventEnvelope>();
    const subscribers = this.#subscribers.get(threadId) ?? new Set<AsyncQueue<EventEnvelope>>();
    this.#subscribers.set(threadId, subscribers);
    subscribers.add(queue);
    const replay = (this.#events.get(threadId) ?? []).filter(({ seq, event }) => seq > (filter.since ?? 0) && matchesEventFilter(event, filter));
    for (const envelope of replay) queue.push(envelope);

    let disconnected = false;
    const disconnect = () => { disconnected = true; queue.close(); };
    response.on("close", disconnect);
    const heartbeat = setInterval(() => {
      if (!response.destroyed && !response.writableNeedDrain) response.write(": keepalive\n\n");
    }, 15_000);
    try {
      for await (const envelope of queue) {
        if (disconnected || response.destroyed) break;
        if (envelope.seq <= (filter.since ?? 0) || !matchesEventFilter(envelope.event, filter)) continue;
        const event = toProtocolEvent(envelope.event, envelope.seq);
        const writable = response.write(`id: ${envelope.seq}\nevent: protocol\ndata: ${JSON.stringify(event)}\n\n`);
        if (!writable && !(await waitForDrain(response))) break;
      }
    } finally {
      clearInterval(heartbeat);
      response.off("close", disconnect);
      queue.close();
      subscribers.delete(queue);
      if (subscribers.size === 0) this.#subscribers.delete(threadId);
      if (!response.destroyed) response.end();
    }
  }

  #eventFilter(): EventStreamFilter {
    return { channels: ["lifecycle", "input", "custom", "values", "updates", "messages", "tools", "checkpoints", "tasks"] };
  }

  async #reconcileThread(threadId: string): Promise<void> {
    const thread = this.#threadMap.get(threadId);
    if (!thread) return;
    const agent = this.#agents.get(thread.agentId);
    if (!agent) throw new Error(`Missing adapter for agent "${thread.agentId}".`);
    const iterator = agent.subscribe(threadId, this.#eventFilter())[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) return;
    await this.#processAgentEvent(thread, first.value);
    this.#startIteratorPump(thread, iterator);
  }

  #ensurePump(threadId: string, restartIfBusy = false): void {
    if (this.#closing) return;
    if (this.#pumps.has(threadId)) {
      if (restartIfBusy) this.#restartPumps.add(threadId);
      return;
    }
    const thread = this.#threadMap.get(threadId);
    if (!thread) return;
    const agent = this.#agents.get(thread.agentId);
    if (!agent) return;
    const iterator = agent.subscribe(threadId, this.#eventFilter())[Symbol.asyncIterator]();
    this.#startIteratorPump(thread, iterator);
  }

  #startIteratorPump(thread: ThreadRecord, iterator: AsyncIterator<HostedAgentEvent>): void {
    const pump = this.#pumpAgentEvents(thread, iterator).finally(() => {
      if (this.#pumps.get(thread.threadId) === pump) this.#pumps.delete(thread.threadId);
      if (this.#restartPumps.delete(thread.threadId)) queueMicrotask(() => this.#ensurePump(thread.threadId));
    });
    this.#pumps.set(thread.threadId, pump);
  }

  async #pumpAgentEvents(thread: ThreadRecord, iterator: AsyncIterator<HostedAgentEvent>): Promise<void> {
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        await this.#processAgentEvent(thread, next.value);
      }
    } catch (error) {
      if (!this.#closing) {
        thread.status = "failed";
        thread.updatedAt = Date.now();
        if (thread.currentRun) {
          thread.currentRun.status = "failed";
          thread.currentRun.updatedAt = thread.updatedAt;
          thread.currentRun.summary = { ...(thread.currentRun.summary ?? {}), error: error instanceof Error ? error.message : String(error) };
        }
        this.#activeThreads.delete(thread.threadId);
        await this.#persist().catch(() => {});
      }
    }
  }

  async #processAgentEvent(thread: ThreadRecord, event: HostedAgentEvent): Promise<void> {
    if (event.threadStatus) {
      thread.status = event.threadStatus;
      thread.updatedAt = Date.now();
      if (event.runId && thread.currentRun?.runId !== event.runId) {
        thread.currentRun = {
          runId: event.runId,
          status: event.threadStatus,
          updatedAt: thread.updatedAt,
          ...(event.summary ? { summary: event.summary } : {}),
        };
      } else if (thread.currentRun) {
        thread.currentRun.status = event.threadStatus;
        thread.currentRun.updatedAt = thread.updatedAt;
        if (event.summary) thread.currentRun.summary = event.summary;
      }
      if (event.threadStatus === "running") this.#activeThreads.add(thread.threadId);
      else this.#activeThreads.delete(thread.threadId);
      if (event.threadStatus === "completed" || event.threadStatus === "failed") {
        if (thread.currentRun) delete thread.currentRun.pendingInputs;
      }
    }

    const data = objectRecord(event.data);
    if (event.method === "input.requested" && data && typeof data.interrupt_id === "string") {
      const runId = event.runId ?? thread.currentRun?.runId ?? thread.threadId;
      if (!thread.currentRun || thread.currentRun.runId !== runId) {
        thread.currentRun = {
          runId,
          status: event.threadStatus ?? "awaiting_input",
          updatedAt: Date.now(),
          ...(event.summary ? { summary: event.summary } : {}),
        };
      }
      const pending = thread.currentRun.pendingInputs ?? [];
      const key = pendingInputKey(event.namespace, data.interrupt_id);
      thread.currentRun.pendingInputs = [
        ...pending.filter((input) => pendingInputKey(input.namespace, input.interruptId) !== key),
        { namespace: [...event.namespace], interruptId: data.interrupt_id, payload: data.payload },
      ];
      if (!event.threadStatus) {
        thread.status = "awaiting_input";
        thread.updatedAt = Date.now();
        this.#activeThreads.delete(thread.threadId);
      }
    } else if (event.method === "input.answered" && data && Array.isArray(data.interrupt_ids)) {
      const answered = new Set(data.interrupt_ids.filter((id): id is string => typeof id === "string"));
      if (thread.currentRun?.pendingInputs) {
        const remaining = thread.currentRun.pendingInputs.filter((input) =>
          !answered.has(input.interruptId) || JSON.stringify(input.namespace) !== JSON.stringify(event.namespace));
        if (remaining.length) thread.currentRun.pendingInputs = remaining;
        else delete thread.currentRun.pendingInputs;
      }
    }

    const seq = (this.#eventSeq.get(thread.threadId) ?? 0) + 1;
    this.#eventSeq.set(thread.threadId, seq);
    thread.eventCursor = seq;
    const envelope = { seq, event };
    this.#state.eventSeqs![thread.threadId] = seq;
    await this.#persist();
    const events = this.#events.get(thread.threadId) ?? [];
    events.push(envelope);
    if (events.length > 128) events.splice(0, events.length - 128);
    this.#events.set(thread.threadId, events);
    for (const subscriber of this.#subscribers.get(thread.threadId) ?? []) subscriber.push(envelope);
  }
}

export function createAgentServer(options: AgentServerOptions | (Omit<AgentServerOptions, "agents"> & { catalog: AgentCatalog })): AgentServer {
  if ("catalog" in options) return new AgentServerRuntime({ ...options, agents: [...options.catalog.agents.values()] });
  return new AgentServerRuntime(options);
}

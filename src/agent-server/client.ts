import { randomInt } from "node:crypto";
import type { Command, CommandData, CommandResponse, ErrorResponse, Event } from "@langchain/protocol";
import type { AgentDescriptor, EventStreamFilter, PublicThreadRecord, ThreadPage } from "./types.ts";

export type PublicThread = PublicThreadRecord;

export class AgentServerClientError extends Error {
  readonly status: number;
  readonly body?: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "AgentServerClientError";
    this.status = status;
    this.body = body;
  }
}

export interface AgentServerClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export class AgentServerClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  #nextCommandId: number;

  constructor(options: AgentServerClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
    this.#nextCommandId = randomInt(1, 2 ** 48);
  }

  /** Reserve a command ID before sending when the caller must persist it for an ambiguous retry. */
  allocateCommandId(): number {
    if (!Number.isSafeInteger(this.#nextCommandId) || this.#nextCommandId >= Number.MAX_SAFE_INTEGER) {
      throw new Error("This client has exhausted its protocol command ID range.");
    }
    return this.#nextCommandId++;
  }

  async listAgents(): Promise<AgentDescriptor[]> {
    const result = await this.#json<{ agents: AgentDescriptor[] }>("/v1/agents");
    return result.agents;
  }

  async getAgent(agentId: string): Promise<AgentDescriptor> {
    return this.#json<AgentDescriptor>(`/v1/agents/${encodeURIComponent(agentId)}`);
  }

  async createThread(input: {
    agentId: string;
    threadId?: string;
    ifExists?: "error" | "do_nothing";
    metadata?: Record<string, unknown>;
  }): Promise<PublicThread> {
    return this.#json<PublicThread>("/v1/threads", { method: "POST", body: JSON.stringify(input) });
  }

  async attachThread(threadId: string): Promise<PublicThread> {
    return this.getThread(threadId);
  }

  async getThread(threadId: string): Promise<PublicThread> {
    return this.#json<PublicThread>(`/v1/threads/${encodeURIComponent(threadId)}`);
  }

  async listThreads(options: { limit?: number; cursor?: string } = {}): Promise<ThreadPage> {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.cursor) query.set("cursor", options.cursor);
    return this.#json<ThreadPage>(`/v1/threads${query.size ? `?${query}` : ""}`);
  }

  async command(threadId: string, command: CommandData & { id?: number }): Promise<CommandResponse> {
    const wire = { ...command, id: command.id ?? this.allocateCommandId() } as Command;
    const response = await this.#request(`${this.#baseUrl}/v1/threads/${encodeURIComponent(threadId)}/commands`, {
      method: "POST",
      headers: this.#headers({ "content-type": "application/json" }),
      body: JSON.stringify(wire),
    });
    const body = await this.#readResponse(response);
    if (!response.ok || (body as { type?: string })?.type === "error") {
      const failure = body as ErrorResponse;
      throw new AgentServerClientError(failure.message ?? `Command failed (${response.status}).`, response.status, body);
    }
    return body as CommandResponse;
  }

  async startRun(threadId: string, assistantId: string, input: unknown, commandId?: number): Promise<CommandResponse> {
    return this.command(threadId, {
      method: "run.start",
      params: { assistant_id: assistantId, input },
      ...(commandId !== undefined ? { id: commandId } : {}),
    });
  }

  async respond(threadId: string, interruptId: string, response: unknown, commandId?: number, namespace: string[] = []): Promise<CommandResponse> {
    return this.command(threadId, {
      method: "input.respond",
      params: { namespace, interrupt_id: interruptId, response },
      ...(commandId !== undefined ? { id: commandId } : {}),
    });
  }

  async getState(threadId: string, options: { namespace?: string[]; keys?: string[]; commandId?: number } = {}): Promise<CommandResponse> {
    return this.command(threadId, {
      method: "state.get",
      params: { namespace: options.namespace ?? [], ...(options.keys ? { keys: options.keys } : {}) },
      ...(options.commandId !== undefined ? { id: options.commandId } : {}),
    });
  }

  async *stream(
    threadId: string,
    filter: EventStreamFilter = { channels: ["lifecycle", "input", "custom"] },
    options: { signal?: AbortSignal; lastEventId?: string } = {},
  ): AsyncIterable<Event> {
    const headers = this.#headers({ "content-type": "application/json", accept: "text/event-stream" });
    if (options.lastEventId) headers.set("last-event-id", options.lastEventId);
    const response = await this.#request(`${this.#baseUrl}/v1/threads/${encodeURIComponent(threadId)}/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify(filter),
      signal: options.signal,
    });
    if (!response.ok || !response.body) {
      const body = await this.#readResponse(response);
      throw new AgentServerClientError(this.#message(body, response.status), response.status, body);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let data: string[] = [];
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffered += decoder.decode(value, { stream: !done });
        let newline: number;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, newline).replace(/\r$/, "");
          buffered = buffered.slice(newline + 1);
          if (line === "") {
            if (data.length) {
              const parsed = JSON.parse(data.join("\n")) as Event;
              data = [];
              if (parsed.type === "event") yield parsed;
            }
            continue;
          }
          if (line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const valuePart = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "data") data.push(valuePart);
        }
        if (done) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  async #json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.#request(`${this.#baseUrl}${path}`, {
      ...init,
      headers: this.#headers({ "content-type": "application/json", ...Object.fromEntries(new Headers(init.headers).entries()) }),
    });
    const body = await this.#readResponse(response);
    if (!response.ok) throw new AgentServerClientError(this.#message(body, response.status), response.status, body);
    return body as T;
  }

  async #request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, init);
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || (error as NodeJS.ErrnoException).code === "ABORT_ERR")) throw error;
      const detail = error instanceof Error ? ` (${error.message})` : "";
      throw new AgentServerClientError(
        `Cannot reach agent server at ${this.#baseUrl}. Run "npm run server" in another terminal and verify AGENT_SERVER_URL${detail}.`,
        0,
      );
    }
  }

  #headers(additional: Record<string, string>): Headers {
    const headers = new Headers(additional);
    headers.set("authorization", `Bearer ${this.#token}`);
    return headers;
  }

  async #readResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return undefined;
    try { return JSON.parse(text); } catch { return text; }
  }

  #message(body: unknown, status: number): string {
    if (body && typeof body === "object") {
      const candidate = body as { message?: unknown; error?: { message?: unknown } };
      if (typeof candidate.message === "string") return candidate.message;
      if (typeof candidate.error?.message === "string") return candidate.error.message;
    }
    return `Agent server request failed (${status}).`;
  }
}

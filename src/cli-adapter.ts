import type { Event } from "@langchain/protocol";
import type { AgentDescriptor, AgentChannel, EventStreamFilter, PublicThreadRecord, ThreadPage } from "./agent-server/types.ts";
import type { CommandResponse } from "@langchain/protocol";

export type CliIO = {
  stdout(text: string): void;
  stderr(text: string): void;
  ask(question: string): Promise<string>;
};

export interface CliClient {
  allocateCommandId(): number;
  listAgents(): Promise<AgentDescriptor[]>;
  createThread(input: { agentId: string; threadId?: string; ifExists?: "error" | "do_nothing"; metadata?: Record<string, unknown> }): Promise<PublicThreadRecord>;
  getThread(threadId: string): Promise<PublicThreadRecord>;
  attachThread(threadId: string): Promise<PublicThreadRecord>;
  listThreads(options?: { limit?: number; cursor?: string }): Promise<ThreadPage>;
  startRun(threadId: string, assistantId: string, input: unknown, commandId?: number): Promise<CommandResponse>;
  respond(threadId: string, interruptId: string, response: unknown, commandId?: number, namespace?: string[]): Promise<CommandResponse>;
  getState(threadId: string, options?: { namespace?: string[]; keys?: string[]; commandId?: number }): Promise<CommandResponse>;
  stream(threadId: string, filter?: EventStreamFilter, options?: { signal?: AbortSignal; lastEventId?: string }): AsyncIterable<Event>;
}

export type CliDependencies = { client: CliClient; io: CliIO };

const STREAM_CHANNELS: AgentChannel[] = ["lifecycle", "input", "custom", "messages", "values", "updates", "tools", "checkpoints", "tasks"];

function usage(): string {
  return [
    "Usage:",
    "  deep-research run --agent <agent-id> --input-json '<JSON input>'",
    "  deep-research chat --agent <agent-id> --input-json '<initial JSON input>'",
    "  deep-research agents",
    "  deep-research list [--agent <agent-id>]",
    "  deep-research resume <thread-id>",
  ].join("\n");
}

function normalizeArgs(args: string[]): string[] {
  return args[0] === "--" ? args.slice(1) : args;
}

function isInterrupted(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || (error as NodeJS.ErrnoException).code === "ABORT_ERR");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseOptions(args: string[]): { agentId?: string; inputJson?: string; positionals: string[] } {
  const parsed: { agentId?: string; inputJson?: string; positionals: string[] } = { positionals: [] };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--") {
      parsed.positionals.push(...args.slice(index + 1));
      break;
    }
    if (argument === "--agent") {
      const value = args[++index];
      if (!value) throw new Error("--agent requires an agent ID.");
      parsed.agentId = value;
      continue;
    }
    if (argument.startsWith("--agent=")) {
      parsed.agentId = argument.slice("--agent=".length);
      if (!parsed.agentId) throw new Error("--agent requires an agent ID.");
      continue;
    }
    if (argument === "--input-json") {
      const value = args[++index];
      if (value === undefined) throw new Error("--input-json requires a JSON value.");
      parsed.inputJson = value;
      continue;
    }
    if (argument.startsWith("--input-json=")) {
      parsed.inputJson = argument.slice("--input-json=".length);
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    parsed.positionals.push(argument);
  }
  return parsed;
}

async function allThreads(client: CliClient, agentId?: string): Promise<PublicThreadRecord[]> {
  const threads: PublicThreadRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listThreads({ ...(cursor ? { cursor } : {}) });
    threads.push(...page.threads.filter((thread) => !agentId || thread.agentId === agentId));
    cursor = page.nextCursor;
  } while (cursor);
  return threads;
}

function threadLabel(thread: PublicThreadRecord): string {
  const summary = thread.currentRun?.summary;
  const request = summary && typeof summary.request === "string" ? summary.request : "";
  return `${thread.threadId}\t${thread.status}\t${thread.agentId}${request ? `\t${request}` : ""}`;
}

function eventData(event: Event): Record<string, unknown> | undefined {
  const params = event.params as { data?: unknown };
  return isRecord(params?.data) ? params.data : undefined;
}

function eventNamespace(event: Event): string[] {
  const params = event.params as { namespace?: unknown };
  return Array.isArray(params?.namespace) && params.namespace.every((part) => typeof part === "string")
    ? params.namespace as string[]
    : [];
}

function inputPrompt(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (isRecord(payload) && typeof payload.question === "string") return payload.question;
  return `Agent requests input:\n${JSON.stringify(payload, null, 2)}\nResponse> `;
}

function interruptKey(namespace: readonly string[], interruptId: string): string {
  return JSON.stringify([namespace, interruptId]);
}

function formatOutput(output: unknown): string {
  const text = typeof output === "string" ? output : JSON.stringify(output, null, 2);
  if (text === undefined) return "undefined\n";
  return text.endsWith("\n") ? text : `${text}\n`;
}

async function printFinalState(threadId: string, client: CliClient, io: CliIO, alreadyPrinted: boolean): Promise<void> {
  if (alreadyPrinted) return;
  try {
    const response = await client.getState(threadId);
    const result = response.result as { values?: unknown };
    if (isRecord(result?.values)) {
      if (Object.hasOwn(result.values, "output")) io.stdout(formatOutput(result.values.output));
      else io.stdout(`${JSON.stringify(result.values, null, 2)}\n`);
    } else {
      io.stdout(`${JSON.stringify(response.result, null, 2)}\n`);
    }
  } catch {
    io.stdout(`Thread ${threadId} completed.\n`);
  }
}

async function monitorThread(threadId: string, dependencies: CliDependencies): Promise<number> {
  const { client, io } = dependencies;
  const thread = await client.getThread(threadId);
  if (!thread.currentRun && thread.status === "idle") {
    io.stderr(`Thread ${threadId} has no active or completed run.\n`);
    return 1;
  }
  io.stderr(`Agent: ${thread.agentId}\n`);
  let finalOutputPrinted = false;
  let lastProgress: string | undefined;
  const handledInterruptIds = new Set<string>();
  const pendingInputs = thread.currentRun?.pendingInputs ?? [];
  if (thread.status === "completed") {
    await printFinalState(threadId, client, io, false);
    return 0;
  }
  if (thread.status === "failed") {
    io.stderr(`${String(thread.currentRun?.summary?.error ?? "Agent run failed.")}\n`);
    return 1;
  }
  const streamCursor = thread.eventCursor ?? 0;
  if (thread.status === "awaiting_input" && pendingInputs.length) {
    for (const pending of pendingInputs) {
      const key = interruptKey(pending.namespace, pending.interruptId);
      handledInterruptIds.add(key);
      const answer = await io.ask(`${inputPrompt(pending.payload)}\n> `);
      await client.respond(threadId, pending.interruptId, answer, client.allocateCommandId(), pending.namespace);
    }
  }
  const filter: EventStreamFilter = {
    channels: STREAM_CHANNELS,
    // If host state lacks a pending-input snapshot, replay events to recover the current interrupt.
    ...(thread.status === "awaiting_input" && !pendingInputs.length ? {} : { since: streamCursor }),
  };

  for await (const event of client.stream(threadId, filter)) {
    const data = eventData(event);
    if (event.method === "lifecycle" && data) {
      const status = typeof data.event === "string" ? data.event : "unknown";
      if (status === "running" || status === "started" || status === "interrupted") {
        const owner = typeof data.agent_id === "string" ? data.agent_id : data.graph_name;
        const line = `${status}${typeof owner === "string" ? ` · ${owner}` : ""}`;
        if (line !== lastProgress) {
          lastProgress = line;
          io.stderr(`Progress: ${line}\n`);
        }
      } else if (status === "completed") {
        await printFinalState(threadId, client, io, finalOutputPrinted);
        return 0;
      } else if (status === "failed") {
        const latest = await client.getThread(threadId).catch(() => undefined);
        const summary = latest?.currentRun?.summary;
        const message = typeof data.error === "string"
          ? data.error
          : summary && typeof summary.error === "string" ? summary.error : "Agent run failed.";
        io.stderr(`${message}\n`);
        return 1;
      }
      continue;
    }

    if (event.method === "input.requested" && data) {
      const interruptId = data.interrupt_id;
      const payload = data.payload;
      if (typeof interruptId !== "string") throw new Error("Agent sent an invalid input.requested event.");
      const namespace = eventNamespace(event);
      const key = interruptKey(namespace, interruptId);
      if (handledInterruptIds.has(key)) continue;
      handledInterruptIds.add(key);
      const answer = await io.ask(`${inputPrompt(payload)}\n> `);
      await client.respond(threadId, interruptId, answer, client.allocateCommandId(), namespace);
      continue;
    }

    if (event.method === "custom" && data) {
      const name = typeof data.name === "string" ? data.name : "custom";
      const payload = data.payload;
      if (name === "agent.progress" && isRecord(payload)) {
        const phase = typeof payload.phase === "string" ? payload.phase : undefined;
        const message = typeof payload.message === "string" ? payload.message : undefined;
        const line = phase && message ? `${phase} · ${message}` : phase ?? message ?? "working";
        if (line !== lastProgress) {
          lastProgress = line;
          io.stderr(`Progress: ${line}\n`);
        }
        continue;
      }
      if (name === "agent.result" && isRecord(payload) && Object.hasOwn(payload, "output")) {
        io.stdout(formatOutput(payload.output));
        finalOutputPrinted = true;
        continue;
      }
      if (isRecord(payload) && typeof payload.report === "string") {
        io.stdout(`${payload.report}\n`);
        finalOutputPrinted = true;
      } else {
        io.stdout(`${JSON.stringify(event)}\n`);
      }
      continue;
    }

    // Preserve useful protocol output from agents that use other standard channels.
    io.stdout(`${JSON.stringify(event)}\n`);
  }

  const latest = await client.getThread(threadId);
  if (latest.status === "completed") {
    await printFinalState(threadId, client, io, finalOutputPrinted);
    return 0;
  }
  if (latest.status === "failed") {
    io.stderr(`${String(latest.currentRun?.summary?.error ?? "Agent run failed.")}\n`);
    return 1;
  }
  io.stderr(`Event stream closed before thread ${threadId} reached a terminal state. Resume with: deep-research resume ${threadId}\n`);
  return 1;
}

async function continueInteractiveThread(
  threadId: string,
  agentId: string,
  initialExitCode: number,
  dependencies: CliDependencies,
): Promise<number> {
  const { client, io } = dependencies;
  let exitCode = initialExitCode;
  while (true) {
    const rawInput = await io.ask(`\nNext turn for ${agentId} as JSON (blank to exit): `);
    if (!rawInput.trim()) return exitCode;
    let input: unknown;
    try {
      input = JSON.parse(rawInput);
    } catch {
      io.stderr("Input must be valid JSON; no run was started.\n");
      continue;
    }

    await client.startRun(threadId, agentId, input, client.allocateCommandId());
    exitCode = await monitorThread(threadId, dependencies);
    const thread = await client.getThread(threadId);
    if (thread.status !== "completed" && thread.status !== "failed") return exitCode;
  }
}

async function startThread(
  agentId: string,
  input: unknown,
  dependencies: CliDependencies,
  onThreadCreated: (threadId: string) => void,
  interactive = false,
): Promise<number> {
  const { client, io } = dependencies;
  const agent = (await client.listAgents()).find((descriptor) => descriptor.id === agentId);
  if (!agent) {
    io.stderr(`Unknown agent "${agentId}". Run "deep-research agents" to discover this server's catalog.\n`);
    return 2;
  }
  if (interactive && agent.threadPolicy !== "multi-turn") {
    io.stderr(`Agent "${agentId}" does not support multi-turn threads. Use "deep-research run" instead.\n`);
    return 2;
  }
  const thread = await client.createThread({ agentId });
  onThreadCreated(thread.threadId);
  io.stderr(`Thread ID: ${thread.threadId}\n`);
  if (interactive) {
    io.stderr("Interactive session started. Enter each next turn as JSON; leave blank to exit.\n");
    if (agent.inputSchema) io.stderr(`Input schema:\n${JSON.stringify(agent.inputSchema, null, 2)}\n`);
  }
  await client.startRun(thread.threadId, agentId, input, client.allocateCommandId());
  const exitCode = await monitorThread(thread.threadId, dependencies);
  return interactive ? continueInteractiveThread(thread.threadId, agentId, exitCode, dependencies) : exitCode;
}

export async function runCli(args: string[], dependencies: CliDependencies): Promise<number> {
  const normalized = normalizeArgs(args);
  let activeThreadId: string | undefined;
  try {
    if (normalized.includes("--help") || normalized.includes("-h")) {
      dependencies.io.stdout(`${usage()}\n`);
      return 0;
    }
    if (!normalized.length) {
      dependencies.io.stderr(`${usage()}\n`);
      return 2;
    }

    if (normalized[0] === "agents") {
      const options = parseOptions(normalized.slice(1));
      if (options.positionals.length || options.agentId || options.inputJson !== undefined) throw new Error('Usage: deep-research agents');
      const agents = await dependencies.client.listAgents();
      dependencies.io.stdout(agents.length
        ? `${agents.map((agent) => `${agent.id}\t${agent.name}\t${agent.threadPolicy}\t${agent.description}`).join("\n")}\n`
        : "No agents are configured on this server.\n");
      return 0;
    }

    if (normalized[0] === "list") {
      const options = parseOptions(normalized.slice(1));
      if (options.positionals.length || options.inputJson !== undefined) throw new Error('Usage: deep-research list [--agent <agent-id>]');
      const threads = await allThreads(dependencies.client, options.agentId);
      dependencies.io.stdout(threads.length
        ? `${threads.map(threadLabel).join("\n")}\n`
        : "No agent threads.\n");
      return 0;
    }

    if (normalized[0] === "resume") {
      if (!normalized[1] || normalized.length !== 2) {
        dependencies.io.stderr("Usage: deep-research resume <thread-id>\n");
        return 2;
      }
      activeThreadId = normalized[1];
      await dependencies.client.attachThread(activeThreadId);
      return await monitorThread(activeThreadId, dependencies);
    }

    if (normalized[0] === "run" || normalized[0] === "chat") {
      const interactive = normalized[0] === "chat";
      const command = interactive ? "chat" : "run";
      const options = parseOptions(normalized.slice(1));
      if (!options.agentId || options.inputJson === undefined || options.positionals.length) {
        dependencies.io.stderr(`Usage: deep-research ${command} --agent <agent-id> --input-json '<JSON input>'\n`);
        return 2;
      }
      let input: unknown;
      try { input = JSON.parse(options.inputJson); }
      catch {
        dependencies.io.stderr("--input-json must contain valid JSON.\n");
        return 2;
      }
      return await startThread(options.agentId, input, dependencies, (threadId) => { activeThreadId = threadId; }, interactive);
    }

    dependencies.io.stderr(`${usage()}\n`);
    return 2;
  } catch (error) {
    if (isInterrupted(error)) {
      dependencies.io.stderr(activeThreadId
        ? `Stopped. Resume with: deep-research resume ${activeThreadId}\n`
        : "Stopped.\n");
      return 130;
    }
    dependencies.io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    if (activeThreadId) dependencies.io.stderr(`If the server accepted the request, resume with: deep-research resume ${activeThreadId}\n`);
    return 1;
  }
}

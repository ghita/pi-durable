export type AgentCapability = "interrupts" | "streaming";

/** An adapter-level rejection made before command admission; retrying with a corrected command is safe. */
export class AgentCommandError extends Error {
  readonly status: number;
  readonly code: "invalid_argument" | "no_such_run" | "not_supported";

  constructor(message: string, status = 400, code: "invalid_argument" | "no_such_run" | "not_supported" = "invalid_argument") {
    super(message);
    this.name = "AgentCommandError";
    this.status = status;
    this.code = code;
  }
}
export type ThreadPolicy = "single-case" | "multi-turn";

export type JsonSchema = Record<string, unknown>;

export interface AgentDescriptor {
  id: string;
  name: string;
  description: string;
  inputSchema?: JsonSchema;
  threadPolicy: ThreadPolicy;
  capabilities: AgentCapability[];
}

export type ThreadStatus = "idle" | "running" | "awaiting_input" | "completed" | "failed";
export type AgentChannel = "values" | "updates" | "messages" | "tools" | "lifecycle" | "input" | "checkpoints" | "tasks" | "custom" | `custom:${string}`;

/** Stable host command types. The protocol adapter translates draft wire shapes into these. */
export type AgentCommand =
  | {
      type: "run.start";
      commandId: string;
      assistantId: string;
      input: unknown;
      config?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      langsmithTracer?: Record<string, unknown>;
    }
  | {
      type: "input.respond";
      commandId: string;
      namespace: string[];
      interruptId: string;
      response: unknown;
      update?: Record<string, unknown>;
      goto?: unknown;
      config?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    }
  | { type: "state.get"; commandId: string; namespace: string[]; keys?: string[] };

export interface AgentCommandResult {
  /** Protocol-compatible result data, translated only by the protocol bridge. */
  result: unknown;
  runId?: string;
  status?: ThreadStatus;
  summary?: Record<string, unknown>;
}

/** Project-owned event shape; wire serialization is isolated in protocol.ts. */
export interface HostedAgentEvent {
  channel: AgentChannel;
  method: string;
  namespace: string[];
  timestamp: number;
  data: unknown;
  threadStatus?: ThreadStatus;
  runId?: string;
  summary?: Record<string, unknown>;
}

export interface EventStreamFilter {
  channels: AgentChannel[];
  namespaces?: string[][];
  depth?: number;
  since?: number;
}

export interface HostedThread {
  threadId: string;
  agentId: string;
  metadata?: Record<string, unknown>;
  /** Opaque, JSON-serializable adapter-owned identity; the host never interprets it. */
  adapterRef?: unknown;
}

export interface HostedAgent {
  descriptor: AgentDescriptor;
  initialize(): Promise<void>;
  /** Idempotently create or rehydrate this adapter's identity for a host-owned thread. */
  createThread(thread: HostedThread): Promise<unknown | void>;
  /** Must be idempotent for a replay of the same stable command ID. */
  handleCommand(threadId: string, command: AgentCommand): Promise<AgentCommandResult>;
  /** If the thread has state, yield its current status first, then subsequent events; yield nothing for a new idle thread. */
  subscribe(threadId: string, filter: EventStreamFilter): AsyncIterable<HostedAgentEvent>;
  close(): Promise<void>;
}

export interface PendingAgentInput {
  namespace: string[];
  interruptId: string;
  payload: unknown;
}

export interface ThreadRunSummary {
  runId: string;
  status: ThreadStatus;
  updatedAt: number;
  summary?: Record<string, unknown>;
  pendingInputs?: PendingAgentInput[];
}

export interface ThreadRecord {
  threadId: string;
  agentId: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  status: ThreadStatus;
  eventCursor?: number;
  currentRun?: ThreadRunSummary;
  /** Opaque adapter data is persisted with the host's thread identity. */
  adapterRef?: unknown;
}

export type PublicThreadRecord = Omit<ThreadRecord, "adapterRef">;

export interface ThreadPage {
  threads: PublicThreadRecord[];
  nextCursor?: string;
}

export interface AgentServerOptions {
  agents: readonly HostedAgent[];
  token: string;
  host?: string;
  port?: number;
  statePath?: string;
  maxConcurrentThreads?: number;
  trustProxy?: boolean;
  trustedProxyAddresses?: string[];
}

export interface AgentServer {
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
  address(): { host: string; port: number } | undefined;
}

export interface AgentCatalog {
  agents: ReadonlyMap<string, HostedAgent>;
  close(): Promise<void>;
}

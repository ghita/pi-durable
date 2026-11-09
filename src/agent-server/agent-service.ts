import type { AgentDescriptor, HostedThread, PendingAgentInput, ThreadStatus } from "./types.ts";

export type AgentRunStatus = Exclude<ThreadStatus, "idle">;

export interface AgentProgress {
  phase?: string;
  message?: string;
  details?: unknown;
}

/** A complete, durable snapshot of the latest run in an agent thread. */
export interface AgentRunSnapshot {
  runId: string;
  status: AgentRunStatus;
  updatedAt: number;
  progress?: AgentProgress;
  pendingInputs?: PendingAgentInput[];
  output?: unknown;
  error?: string;
  /** Agent-owned state exposed through the protocol's state.get command. */
  state?: Record<string, unknown>;
  summary?: Record<string, unknown>;
}

/** A protocol-neutral custom event emitted alongside a complete snapshot. */
export interface AgentServiceEvent {
  name: string;
  payload: unknown;
  namespace?: string[];
  timestamp?: number;
}

/** Each update includes the full state, so consumers can recover after reconnecting. */
export interface AgentServiceUpdate {
  snapshot: AgentRunSnapshot;
  events?: AgentServiceEvent[];
}

export interface AgentRunStartOptions {
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  langsmithTracer?: Record<string, unknown>;
}

export interface AgentInputResponseOptions {
  update?: Record<string, unknown>;
  goto?: unknown;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Application-owned lifecycle contract. Implementations own durable thread/run state;
 * command IDs must be used to make startRun and respond idempotent across retries.
 */
export interface AgentService {
  descriptor: AgentDescriptor;
  initialize?(): Promise<void>;
  /** Idempotently create or rehydrate the service's conversation for this host thread. */
  createThread(thread: HostedThread): Promise<unknown | void>;
  /** Start a new run/turn in this thread and return once it has been durably accepted. */
  startRun(
    threadId: string,
    input: unknown,
    commandId: string,
    options?: AgentRunStartOptions,
  ): Promise<AgentRunSnapshot>;
  /** Continue the currently interrupted run; each pending input is answered separately. */
  respond(
    threadId: string,
    input: { namespace: string[]; interruptId: string; response: unknown; commandId: string },
    options?: AgentInputResponseOptions,
  ): Promise<AgentRunSnapshot>;
  /** Return the latest run snapshot, or undefined if this thread has not started a run. */
  getSnapshot(threadId: string, namespace?: string[]): Promise<AgentRunSnapshot | undefined>;
  /** Yield the current snapshot first, then full snapshots for that run; finish when it reaches a terminal state. */
  watch(threadId: string): AsyncIterable<AgentServiceUpdate>;
  close(): Promise<void>;
}

export type AgentServiceFactory = (context: {
  agentId: string;
  manifestDirectory: string;
  env: NodeJS.ProcessEnv;
}) => AgentService | Promise<AgentService>;

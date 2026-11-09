import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord";
import {
  AssistantEntry,
  ConversationBusy,
  createRegistry,
  defineDoc,
  Harness,
  type AgentChange,
  type Conversation,
  type Harness as DurableHarness,
  type Registry,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AgentService, AgentServiceUpdate, AgentRunSnapshot } from "./agent-service.ts";
import { AgentCommandError, type AgentDescriptor, type HostedThread } from "./types.ts";

type DurableConversationState = Record<string, JsonValue> & {
  latestSubmissionId: number | null;
};

const DurableConversationDoc = defineDoc<DurableConversationState>({
  kind: "app.agent-service.conversation",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => true,
  initial: () => ({ latestSubmissionId: null }),
});

export interface DurableConversationServiceOptions {
  descriptor: AgentDescriptor;
  dataDirectory: string;
  models: Models;
  registry?: Registry;
  agent?: AgentChange;
  context?: Context;
  parseInput?: (input: unknown) => string;
}

type OpenConversation = { harness: DurableHarness; conversation: Conversation };

class AsyncQueue<T> implements AsyncIterableIterator<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#values.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  async return(): Promise<IteratorResult<T>> {
    this.close();
    return { done: true, value: undefined };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> { return this; }
}

function defaultMessage(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AgentCommandError("Conversation input must be a string or an object with a message string.");
  }
  const message = (input as { message?: unknown }).message;
  if (typeof message !== "string" || !message.trim()) {
    throw new AgentCommandError("Conversation input must include a non-empty message string.");
  }
  return message.trim();
}

function textFromAssistantEntry(entry: { model?: readonly unknown[] } | undefined): string | undefined {
  if (!entry?.model) return undefined;
  const text: string[] = [];
  for (const message of entry.model) {
    if (!message || typeof message !== "object" || !("content" in message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block && typeof block === "object" && "type" in block && block.type === "text"
        && "text" in block && typeof block.text === "string") text.push(block.text);
    }
  }
  return text.length ? text.join("") : undefined;
}

function safeThreadKey(threadId: string): string {
  return createHash("sha256").update(threadId).digest("hex");
}

function statusForSubmission(status: string): AgentRunSnapshot["status"] {
  if (status === "queued" || status === "placed") return "running";
  if (status === "done") return "completed";
  return "failed";
}

/**
 * Host a normal Pi Durable conversation as a multi-turn agent service. The Durable conversation is the source of truth;
 * this helper provides only thread-to-storage wiring and the common snapshot/stream shape.
 */
export function createDurableConversationService(options: DurableConversationServiceOptions): AgentService {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const registry = options.registry ?? createRegistry();
  const sessions = new Map<string, OpenConversation>();
  const updatedSnapshots = new Map<string, { signature: string; updatedAt: number }>();

  function session(threadId: string): OpenConversation {
    const opened = sessions.get(threadId);
    if (!opened) throw new AgentCommandError(`Unknown conversation thread: ${threadId}`, 404, "no_such_run");
    return opened;
  }

  async function snapshot(threadId: string): Promise<AgentRunSnapshot | undefined> {
    const { harness, conversation } = session(threadId);
    const state = await harness.snapshot(DurableConversationDoc, conversation.id, context);
    if (!state || typeof state.latestSubmissionId !== "number") return undefined;
    const submission = await harness.submission(state.latestSubmissionId as SubmissionId, context);
    if (!submission) return undefined;
    const record = await submission.status(context);
    const status = statusForSubmission(record.status);
    const output = record.status === "done" && record.type === "input"
      ? textFromAssistantEntry(await conversation.commit((tx) => tx.entry(AssistantEntry, record.answer), context))
      : undefined;
    const error = record.status === "unanswered"
      ? `${record.reason}${record.detail === undefined ? "" : `: ${JSON.stringify(record.detail)}`}`
      : undefined;
    const runId = String(state.latestSubmissionId);
    const signature = JSON.stringify({ runId, status, output, error });
    const cached = updatedSnapshots.get(threadId);
    const updatedAt = cached?.signature === signature ? cached.updatedAt : Date.now();
    updatedSnapshots.set(threadId, { signature, updatedAt });
    return {
      runId,
      status,
      updatedAt,
      ...(status === "running" ? { progress: { phase: "generating" } } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(error ? { error } : {}),
      state: {
        conversationId: String(conversation.id),
        submissionId: runId,
        requestId: record.requestId ?? "",
        submissionStatus: record.status,
      },
    };
  }

  return {
    descriptor: structuredClone(options.descriptor),
    async createThread(thread: HostedThread) {
      if (sessions.has(thread.threadId)) return;
      const directory = join(options.dataDirectory, options.descriptor.id);
      await mkdir(directory, { recursive: true });
      const storagePath = join(directory, `${safeThreadKey(thread.threadId)}.sqlite`);
      const harness = await Harness.open(await openNodeSqliteStorage(storagePath), {
        models: options.models,
        registry,
      }, context);
      try {
        const conversation = await harness.root(context, options.agent ? { agent: options.agent } : undefined);
        sessions.set(thread.threadId, { harness, conversation });
      } catch (error) {
        await harness.close(context).catch(() => {});
        throw error;
      }
    },
    async startRun(threadId, input, commandId, runOptions = {}) {
      if (runOptions.config !== undefined || runOptions.metadata !== undefined || runOptions.langsmithTracer !== undefined) {
        throw new AgentCommandError("This Durable conversation service does not support per-run config, metadata, or tracing overrides.", 501, "not_supported");
      }
      const message = (options.parseInput ?? defaultMessage)(input);
      if (!message.trim()) throw new AgentCommandError("Conversation input must not be empty.");
      const { conversation } = session(threadId);
      try {
        const submissionId = await conversation.commit(async (tx) => {
          const state = await tx.doc(DurableConversationDoc, conversation.id);
          const id = await conversation.submit(tx, {
            type: "input",
            content: message,
            requestId: commandId,
            whenBusy: "reject",
          });
          state.latestSubmissionId = id;
          return id;
        }, context);
        return (await snapshot(threadId)) ?? {
          runId: String(submissionId),
          status: "running",
          updatedAt: Date.now(),
          progress: { phase: "queued" },
        };
      } catch (error) {
        if (error instanceof ConversationBusy) throw new AgentCommandError("Conversation already has an active run.", 409);
        throw error;
      }
    },
    async respond(_threadId, _input) {
      throw new AgentCommandError("This Durable conversation agent does not expose mid-run input requests.", 501, "not_supported");
    },
    async getSnapshot(threadId, namespace = []) {
      if (namespace.length) throw new AgentCommandError("Only the root conversation is available.", 501, "not_supported");
      return snapshot(threadId);
    },
    async *watch(threadId): AsyncIterable<AgentServiceUpdate> {
      const { conversation } = session(threadId);
      // Startup reconciliation subscribes to every saved thread, including idle ones. An idle thread has no run update;
      // finish immediately so it cannot block the HTTP listener from starting.
      if (!await snapshot(threadId)) return;
      const watch = await conversation.watch(context);
      const queue = new AsyncQueue<boolean>();
      queue.push(true);
      watch.start(async (call) => {
        if (call.kind === "value") queue.push(true);
        else queue.close();
      });
      void watch.closed.then(() => queue.close());
      try {
        for await (const _change of queue) {
          const current = await snapshot(threadId);
          if (!current) continue;
          yield { snapshot: current };
          if (current.status === "completed" || current.status === "failed") return;
        }
      } finally {
        queue.close();
        await watch.stop();
      }
    },
    async close() {
      const opened = [...sessions.values()];
      sessions.clear();
      await Promise.all(opened.map(({ harness }) => harness.close(context)));
    },
  };
}

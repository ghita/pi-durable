import { randomUUID } from "node:crypto";
import { access, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { SearchProvider } from "./research-tools.ts";
import { createResearchToolsExtension } from "./research-tools.ts";
import { createResearchRuntime, researchConfig } from "./research-config.ts";
import {
  CoordinatorTask,
  ResearchExtension,
  RunDoc,
  type ClarificationExchange,
  type CoordinatorResult,
  type ModelChoice,
  type ResearchConfig,
  type RunRecord,
  type RunStatus,
} from "./workflow.ts";

export const DEEP_RESEARCH_AGENT_ID = "deep-research";

export type RunId = string;
export type ResearchRunPhase = "clarifying" | "preparing" | "researching" | "synthesizing" | "writing_report" | "completed";

export type ResearchRunSnapshot = {
  runId: RunId;
  agentId: string;
  request: string;
  status: RunStatus;
  phase?: ResearchRunPhase;
  pendingQuestion?: string;
  report?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

export type ResearchAgentDescriptor = { id: string; name: string; description: string };

export interface ResearchRunAgent {
  listAgents(): Promise<ResearchAgentDescriptor[]>;
  start(input: { agentId: string; request: string }): Promise<ResearchRunSnapshot>;
  get(runId: RunId): Promise<ResearchRunSnapshot | undefined>;
  listRuns(): Promise<ResearchRunSnapshot[]>;
  resume(runId: RunId): Promise<ResearchRunSnapshot>;
  answerClarification(runId: RunId, answer: string): Promise<ResearchRunSnapshot>;
  watch(runId: RunId): AsyncIterable<ResearchRunSnapshot>;
  close(): Promise<void>;
}

/** Host-side seams for tests and embedding. Normal clients use the methods on ResearchRunAgent. */
export type ResearchRunAgentOptions = {
  cwd?: string;
  context?: Context;
  models?: MutableModels;
  model?: ModelChoice;
  search?: SearchProvider;
  searchConfigured?: boolean;
  recoverOnStart?: boolean;
  env?: NodeJS.ProcessEnv;
};

export class ResearchRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`No saved run with ID ${runId}.`);
    this.name = "ResearchRunNotFoundError";
  }
}

export class ResearchRunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchRunStateError";
  }
}

export class ResearchAgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Unknown research agent: ${agentId}`);
    this.name = "ResearchAgentNotFoundError";
  }
}

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGENTS: ResearchAgentDescriptor[] = [{
  id: DEEP_RESEARCH_AGENT_ID,
  name: "Deep Research",
  description: "Research a request with bounded parallel web researchers and produce a cited report.",
}];

function publicPhase(phase: string | undefined): ResearchRunPhase | undefined {
  switch (phase) {
    case "clarify": return "clarifying";
    case "brief": return "preparing";
    case "supervise":
    case "research": return "researching";
    case "compress": return "synthesizing";
    case "report": return "writing_report";
    case "completed": return "completed";
    default: return undefined;
  }
}

function toSnapshot(run: Readonly<RunRecord>): ResearchRunSnapshot {
  return {
    runId: run.runId,
    agentId: run.agentId ?? DEEP_RESEARCH_AGENT_ID,
    request: run.topic,
    status: run.status,
    phase: publicPhase(run.phase),
    ...(run.pendingQuestion !== undefined ? { pendingQuestion: run.pendingQuestion } : {}),
    ...(run.report !== undefined ? { report: run.report } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function snapshotKey(snapshot: ResearchRunSnapshot): string {
  return JSON.stringify({
    agentId: snapshot.agentId,
    request: snapshot.request,
    status: snapshot.status,
    phase: snapshot.phase,
    pendingQuestion: snapshot.pendingQuestion,
    report: snapshot.report,
    error: snapshot.error,
  });
}

async function persistCoordinatorTask(
  harness: Harness,
  start: { kind: "new"; runId: RunId; topic: string; config: ResearchConfig } | { kind: "answer"; runId: RunId; answer: string },
  context: Context,
): Promise<TaskId<CoordinatorResult>> {
  const root = start.kind === "new"
    ? await harness.root(context, { agent: { model: start.config.model } })
    : await harness.root(context);
  return root.commit(async (tx) => {
    const run = await tx.doc(RunDoc);
    let topic: string;
    let config: ResearchConfig;
    let history: ClarificationExchange[];
    const initial = start.kind === "new";

    if (initial) {
      topic = start.topic;
      config = start.config;
      history = [];
      run.runId = start.runId;
      run.topic = topic;
      run.createdAt = Date.now();
      run.agentId = DEEP_RESEARCH_AGENT_ID;
    } else {
      if (run.status !== "awaiting_clarification" || !run.pendingQuestion) {
        throw new ResearchRunStateError(`Run ${start.runId} is not awaiting clarification.`);
      }
      if (!run.config) throw new ResearchRunStateError(`Run ${start.runId} has no saved configuration.`);
      topic = run.topic;
      config = run.config;
      history = [...run.clarificationHistory, { question: run.pendingQuestion, answer: start.answer }];
    }

    run.status = "running";
    run.updatedAt = Date.now();
    run.phase = "clarify";
    run.config = config;
    run.clarificationHistory = history;
    delete run.pendingQuestion;
    const id = await tx.createTask(
      CoordinatorTask,
      { runId: start.runId, topic, config, clarificationHistory: history },
      { ownership: { kind: "conversation" } },
    );
    run.coordinatorTaskId = id;
    return id;
  }, context);
}

async function waitForCoordinator(
  harness: Harness,
  id: TaskId<CoordinatorResult>,
  context: Context,
): Promise<CoordinatorResult> {
  const settled = await harness.waitForTask(id, context);
  const outcome = settled.state.outcome;
  if (outcome.status !== "completed") {
    const message = outcome.status === "failed" || outcome.status === "faulted"
      ? outcome.error.message
      : `Research task ended with status ${outcome.status}.`;
    throw new Error(message);
  }
  return outcome.result;
}

async function markRunFailed(harness: Harness, error: unknown, context: Context): Promise<void> {
  await harness.commit(async (tx) => {
    const run = await tx.doc(RunDoc);
    if (run.status === "completed" || run.status === "awaiting_clarification") return;
    run.status = "failed";
    run.error = error instanceof Error ? error.message : String(error);
    run.updatedAt = Date.now();
  }, context);
}

type AgentDependencies = {
  cwd: string;
  context: Context;
  models: MutableModels;
  model: ModelChoice;
  search: SearchProvider;
  searchConfigured: boolean;
  env: NodeJS.ProcessEnv;
};

type ActiveRun = { harness: Harness; done: Promise<void> };

class DurableResearchRunAgent implements ResearchRunAgent {
  readonly #dependencies: AgentDependencies;
  readonly #runDirectory: string;
  readonly #active = new Map<RunId, ActiveRun>();
  readonly #recovering = new Map<RunId, Promise<void>>();
  #closing = false;

  constructor(dependencies: AgentDependencies) {
    this.#dependencies = dependencies;
    this.#runDirectory = join(resolve(dependencies.cwd), ".deep-research", "runs");
  }

  async initialize(recoverOnStart: boolean): Promise<void> {
    if (!recoverOnStart) return;
    let files: string[];
    try {
      files = await readdir(this.#runDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const file of files.filter((entry) => entry.endsWith(".sqlite"))) {
      const runId = file.slice(0, -".sqlite".length);
      if (!RUN_ID_PATTERN.test(runId)) continue;
      const snapshot = await this.get(runId);
      if (snapshot?.status === "running") await this.resume(runId);
    }
  }

  async listAgents(): Promise<ResearchAgentDescriptor[]> {
    return AGENTS.map((agent) => ({ ...agent }));
  }

  async start(input: { agentId: string; request: string }): Promise<ResearchRunSnapshot> {
    this.#assertOpen();
    if (input.agentId !== DEEP_RESEARCH_AGENT_ID) throw new ResearchAgentNotFoundError(input.agentId);
    const topic = input.request.trim();
    if (!topic) throw new Error("Research request must not be empty.");

    const runId = randomUUID();
    await mkdir(this.#runDirectory, { recursive: true });
    const harness = await this.#openHarness(join(this.#runDirectory, `${runId}.sqlite`));
    try {
      const config = researchConfig(
        this.#dependencies.env,
        this.#dependencies.model,
        this.#dependencies.searchConfigured,
      );
      const taskId = await persistCoordinatorTask(harness, { kind: "new", runId, topic, config }, this.#dependencies.context);
      const record = await harness.snapshot(RunDoc, this.#dependencies.context);
      if (!record) throw new Error(`Run database ${runId} has no research state.`);
      const initialSnapshot = toSnapshot(record);
      this.#launch(runId, harness, taskId);
      return initialSnapshot;
    } catch (error) {
      await harness.close(this.#dependencies.context).catch(() => {});
      throw error;
    }
  }

  async get(runId: RunId): Promise<ResearchRunSnapshot | undefined> {
    if (!RUN_ID_PATTERN.test(runId)) return undefined;
    const active = this.#active.get(runId);
    if (active) {
      const record = await active.harness.snapshot(RunDoc, this.#dependencies.context);
      return record ? toSnapshot(record) : undefined;
    }

    const path = join(this.#runDirectory, `${runId}.sqlite`);
    try {
      await access(path);
    } catch {
      return undefined;
    }
    const harness = await this.#openHarness(path, true);
    try {
      const record = await harness.snapshot(RunDoc, this.#dependencies.context);
      return record ? toSnapshot(record) : undefined;
    } finally {
      await harness.close(this.#dependencies.context).catch(() => {});
    }
  }

  async listRuns(): Promise<ResearchRunSnapshot[]> {
    let files: string[];
    try {
      files = await readdir(this.#runDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const snapshots: ResearchRunSnapshot[] = [];
    for (const file of files.filter((entry) => entry.endsWith(".sqlite")).sort()) {
      const runId = file.slice(0, -".sqlite".length);
      if (!RUN_ID_PATTERN.test(runId)) continue;
      try {
        const snapshot = await this.get(runId);
        if (snapshot) snapshots.push(snapshot);
      } catch {
        // A corrupt or partially written run should not hide other saved runs.
      }
    }
    return snapshots;
  }

  async resume(runId: RunId): Promise<ResearchRunSnapshot> {
    this.#assertOpen();
    const snapshot = await this.get(runId);
    if (!snapshot) throw new ResearchRunNotFoundError(runId);
    if (snapshot.status !== "running" || this.#active.has(runId)) return snapshot;

    let recovering = this.#recovering.get(runId);
    if (!recovering) {
      recovering = this.#recover(runId);
      this.#recovering.set(runId, recovering);
    }
    try {
      await recovering;
    } finally {
      if (this.#recovering.get(runId) === recovering) this.#recovering.delete(runId);
    }
    return (await this.get(runId)) ?? snapshot;
  }

  async answerClarification(runId: RunId, answer: string): Promise<ResearchRunSnapshot> {
    this.#assertOpen();
    const initial = await this.get(runId);
    if (!initial) throw new ResearchRunNotFoundError(runId);
    if (initial.status !== "awaiting_clarification") {
      throw new ResearchRunStateError(`Run ${runId} is not awaiting clarification.`);
    }
    const active = this.#active.get(runId);
    if (active) await active.done;

    const current = await this.get(runId);
    if (!current) throw new ResearchRunNotFoundError(runId);
    if (current.status !== "awaiting_clarification") {
      throw new ResearchRunStateError(`Run ${runId} is not awaiting clarification.`);
    }

    const harness = await this.#openHarness(join(this.#runDirectory, `${runId}.sqlite`));
    try {
      const taskId = await persistCoordinatorTask(harness, { kind: "answer", runId, answer }, this.#dependencies.context);
      const record = await harness.snapshot(RunDoc, this.#dependencies.context);
      if (!record) throw new Error(`Run database ${runId} has no research state.`);
      const snapshot = toSnapshot(record);
      this.#launch(runId, harness, taskId);
      return snapshot;
    } catch (error) {
      await harness.close(this.#dependencies.context).catch(() => {});
      throw error;
    }
  }

  async *watch(runId: RunId): AsyncIterable<ResearchRunSnapshot> {
    let snapshot = await this.get(runId);
    if (!snapshot) throw new ResearchRunNotFoundError(runId);
    if (snapshot.status === "queued" || snapshot.status === "running") {
      await this.resume(runId);
      snapshot = await this.get(runId);
      if (!snapshot) throw new ResearchRunNotFoundError(runId);
    }
    if (snapshot.status !== "queued" && snapshot.status !== "running") {
      yield snapshot;
      return;
    }

    const active = this.#active.get(runId);
    if (!active) {
      yield snapshot;
      return;
    }
    const watch = await active.harness.watchDoc(RunDoc, this.#dependencies.context);
    if (!watch) {
      yield snapshot;
      return;
    }

    const queue: ResearchRunSnapshot[] = [toSnapshot(watch.value)];
    let wake: (() => void) | undefined;
    let failure: unknown;
    let ended = false;
    const signal = () => {
      wake?.();
      wake = undefined;
    };
    watch.start(async (call) => {
      if (call.kind === "failed") failure = call.error;
      else queue.push(toSnapshot(call.value));
      signal();
    });
    void watch.closed.then(() => {
      ended = true;
      signal();
    });

    let previous: string | undefined;
    try {
      while (true) {
        if (failure !== undefined) throw failure;
        if (queue.length === 0) {
          if (ended) break;
          await new Promise<void>((resolveWake) => { wake = resolveWake; });
          continue;
        }
        snapshot = queue.shift()!;
        const key = snapshotKey(snapshot);
        if (key !== previous) {
          previous = key;
          yield snapshot;
        }
        if (snapshot.status !== "queued" && snapshot.status !== "running") return;
      }

      const latest = await this.get(runId);
      if (latest) {
        yield latest;
        if (latest.status === "queued" || latest.status === "running") {
          throw new Error(`Progress watch for run ${runId} ended before the run settled.`);
        }
      }
    } finally {
      await watch.stop();
    }
  }

  async close(): Promise<void> {
    this.#closing = true;
    await Promise.all([...this.#active.values()].map(({ done }) => done));
  }

  async #recover(runId: RunId): Promise<void> {
    const harness = await this.#openHarness(join(this.#runDirectory, `${runId}.sqlite`));
    try {
      const record = await harness.snapshot(RunDoc, this.#dependencies.context);
      if (!record || record.status !== "running") {
        await harness.close(this.#dependencies.context).catch(() => {});
        return;
      }
      if (!record.coordinatorTaskId) {
        await markRunFailed(harness, new Error("Saved run is missing its coordinator task."), this.#dependencies.context);
        await harness.close(this.#dependencies.context).catch(() => {});
        return;
      }
      this.#launch(runId, harness, record.coordinatorTaskId);
    } catch (error) {
      await harness.close(this.#dependencies.context).catch(() => {});
      throw error;
    }
  }

  #launch(runId: RunId, harness: Harness, taskId: TaskId<CoordinatorResult>): void {
    const active: ActiveRun = { harness, done: Promise.resolve() };
    this.#active.set(runId, active);
    active.done = this.#drive(runId, active, taskId);
  }

  async #drive(runId: RunId, active: ActiveRun, taskId: TaskId<CoordinatorResult>): Promise<void> {
    try {
      await waitForCoordinator(active.harness, taskId, this.#dependencies.context);
    } catch (error) {
      await markRunFailed(active.harness, error, this.#dependencies.context).catch(() => {});
    } finally {
      if (this.#active.get(runId) === active) this.#active.delete(runId);
      await active.harness.close(this.#dependencies.context).catch(() => {});
    }
  }

  async #openHarness(path: string, readOnly = false): Promise<Harness> {
    const installed = createRegistry();
    installed.install(ResearchExtension);
    installed.install(await createResearchToolsExtension(this.#dependencies.search, this.#dependencies.env.UI_REACT_SKILLS_DIR, this.#dependencies.env));
    return Harness.open(
      await openNodeSqliteStorage(path),
      { models: this.#dependencies.models, registry: installed, readOnly },
      this.#dependencies.context,
    );
  }

  #assertOpen(): void {
    if (this.#closing) throw new Error("ResearchRunAgent is closing and cannot accept new operations.");
  }
}

export async function createResearchRunAgent(options: ResearchRunAgentOptions = {}): Promise<ResearchRunAgent> {
  const env = options.env ?? process.env;
  const runtime = createResearchRuntime(env);
  const agent = new DurableResearchRunAgent({
    cwd: options.cwd ?? process.cwd(),
    context: options.context ?? BACKGROUND_CONTEXT,
    models: options.models ?? runtime.models,
    model: options.model ?? runtime.model,
    search: options.search ?? runtime.search,
    searchConfigured: options.searchConfigured ?? runtime.searchConfigured,
    env,
  });
  await agent.initialize(options.recoverOnStart ?? true);
  return agent;
}

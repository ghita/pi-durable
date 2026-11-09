import { randomUUID } from "node:crypto";
import {
  createResearchRunAgent,
  DEEP_RESEARCH_AGENT_ID,
  ResearchAgentNotFoundError,
  ResearchRunNotFoundError,
  ResearchRunStateError,
  type ResearchRunAgent,
  type ResearchRunSnapshot,
} from "../research-run-agent.ts";
import type { AgentFactoryContext } from "./catalog.ts";
import type { AgentRunStatus, AgentService, AgentRunSnapshot } from "./agent-service.ts";
import { createHostedAgentAdapter } from "./host-adapter.ts";
import { AgentCommandError, type AgentDescriptor, type HostedAgent, type HostedThread } from "./types.ts";

export const researchAgentDescriptor: AgentDescriptor = {
  id: DEEP_RESEARCH_AGENT_ID,
  name: "Deep Research",
  description: "Research a request with bounded parallel web researchers and produce a cited report.",
  inputSchema: {
    type: "object",
    properties: { request: { type: "string", minLength: 1, description: "The research case to investigate." } },
    required: ["request"],
    additionalProperties: false,
  },
  threadPolicy: "single-case",
  capabilities: ["interrupts", "streaming"],
};

export interface ResearchAgentServiceOptions {
  agent?: ResearchRunAgent;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** @deprecated Prefer ResearchAgentServiceOptions. */
export type ResearchHostedAgentOptions = ResearchAgentServiceOptions;

const DURABLE_RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function threadRunId(thread: HostedThread): string {
  const ref = thread.adapterRef;
  if (ref && typeof ref === "object" && !Array.isArray(ref) && typeof (ref as { runId?: unknown }).runId === "string") {
    return (ref as { runId: string }).runId;
  }
  return DURABLE_RUN_ID_PATTERN.test(thread.threadId) ? thread.threadId : randomUUID();
}

function threadStatus(snapshot: ResearchRunSnapshot): AgentRunStatus {
  switch (snapshot.status) {
    case "queued":
    case "running": return "running";
    case "awaiting_clarification": return "awaiting_input";
    case "completed": return "completed";
    case "failed": return "failed";
  }
}

export function researchInterruptId(runId: string, snapshot: ResearchRunSnapshot): string {
  return `research:${runId}:clarification:${snapshot.updatedAt}`;
}

function researchInterruptVersion(runId: string, interruptId: string): number | undefined {
  const prefix = `research:${runId}:clarification:`;
  if (!interruptId.startsWith(prefix)) return undefined;
  const version = Number(interruptId.slice(prefix.length));
  return Number.isSafeInteger(version) && version >= 0 ? version : undefined;
}

function publicSummary(snapshot: ResearchRunSnapshot): Record<string, unknown> {
  return {
    request: snapshot.request,
    ...(snapshot.phase ? { phase: snapshot.phase } : {}),
    ...(snapshot.pendingQuestion ? { pendingQuestion: snapshot.pendingQuestion } : {}),
    ...(snapshot.error ? { error: snapshot.error } : {}),
  };
}

function toServiceSnapshot(runId: string, snapshot: ResearchRunSnapshot): AgentRunSnapshot {
  const status = threadStatus(snapshot);
  return {
    runId,
    status,
    updatedAt: snapshot.updatedAt,
    ...(snapshot.phase ? { progress: { phase: snapshot.phase } } : {}),
    ...(status === "awaiting_input" && snapshot.pendingQuestion ? {
      pendingInputs: [{
        namespace: [],
        interruptId: researchInterruptId(runId, snapshot),
        payload: { question: snapshot.pendingQuestion },
      }],
    } : {}),
    ...(snapshot.report !== undefined ? { output: snapshot.report } : {}),
    ...(snapshot.error ? { error: snapshot.error } : {}),
    state: {
      thread_id: runId,
      run_id: snapshot.runId,
      agent_id: snapshot.agentId,
      request: snapshot.request,
      status: snapshot.status,
      ...(snapshot.phase ? { phase: snapshot.phase } : {}),
      ...(snapshot.pendingQuestion ? { pendingQuestion: snapshot.pendingQuestion } : {}),
      ...(snapshot.report !== undefined ? { report: snapshot.report } : {}),
      ...(snapshot.error ? { error: snapshot.error } : {}),
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    },
    summary: publicSummary(snapshot),
  };
}

function readRequest(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AgentCommandError("run.start input must be an object with a request string.");
  const request = (input as { request?: unknown }).request;
  if (typeof request !== "string" || !request.trim()) throw new AgentCommandError("run.start input must include a non-empty request.");
  return request.trim();
}

function rejectRunOptions(options: { config?: unknown; metadata?: unknown; langsmithTracer?: unknown }): void {
  if (options.config !== undefined || options.metadata !== undefined || options.langsmithTracer !== undefined) {
    throw new AgentCommandError("ResearchRunAgent does not support run config, metadata, or LangSmith tracing overrides.", 501, "not_supported");
  }
}

function translateResearchCommandError(error: unknown): never {
  if (error instanceof ResearchRunNotFoundError) throw new AgentCommandError(error.message, 404, "no_such_run");
  if (error instanceof ResearchRunStateError || error instanceof ResearchAgentNotFoundError) throw new AgentCommandError(error.message, 409);
  throw error;
}

export function createResearchAgentService(options: ResearchAgentServiceOptions = {}): AgentService {
  let agentPromise: Promise<ResearchRunAgent> | undefined = options.agent ? Promise.resolve(options.agent) : undefined;
  const getAgent = () => agentPromise ??= createResearchRunAgent({ cwd: options.cwd, env: options.env });
  const threadRuns = new Map<string, string>();

  const service: AgentService = {
    descriptor: structuredClone(researchAgentDescriptor),
    async initialize() {
      await getAgent();
    },
    async createThread(thread) {
      const runId = threadRunId(thread);
      threadRuns.set(thread.threadId, runId);
      return runId === thread.threadId ? undefined : { runId };
    },
    async startRun(threadId, input, commandId, runOptions = {}) {
      rejectRunOptions(runOptions);
      const runId = threadRuns.get(threadId);
      if (!runId) throw new AgentCommandError(`Unknown research thread: ${threadId}`, 404, "no_such_run");
      const agent = await getAgent();
      const request = readRequest(input);
      const existing = await agent.get(runId);
      let snapshot: ResearchRunSnapshot;
      if (existing) {
        if (existing.request !== request) throw new AgentCommandError("This research thread is permanently bound to another case.", 409);
        snapshot = existing;
      } else {
        try { snapshot = await agent.start({ agentId: DEEP_RESEARCH_AGENT_ID, request, runId }); }
        catch (error) { translateResearchCommandError(error); }
      }
      // start() is idempotent for this single-case thread: a command retry resolves to the same run.
      void commandId;
      return toServiceSnapshot(runId, snapshot);
    },
    async respond(threadId, input, responseOptions = {}) {
      const runId = threadRuns.get(threadId);
      if (!runId) throw new AgentCommandError(`Unknown research thread: ${threadId}`, 404, "no_such_run");
      if (input.namespace.length !== 0) throw new AgentCommandError("ResearchRunAgent accepts clarification responses only in the root namespace.", 501, "not_supported");
      if (responseOptions.update !== undefined || responseOptions.goto !== undefined || responseOptions.config !== undefined || responseOptions.metadata !== undefined) {
        throw new AgentCommandError("ResearchRunAgent does not support input.respond update, goto, config, or metadata options.", 501, "not_supported");
      }
      const agent = await getAgent();
      const current = await agent.get(runId);
      if (!current) throw new AgentCommandError(`No research run exists for thread ${threadId}.`, 404, "no_such_run");
      const expectedUpdatedAt = researchInterruptVersion(runId, input.interruptId);
      if (expectedUpdatedAt === undefined) throw new AgentCommandError("Clarification interrupt ID does not belong to this thread.", 409);
      const response = typeof input.response === "string"
        ? input.response
        : input.response && typeof input.response === "object" && typeof (input.response as { answer?: unknown }).answer === "string"
          ? (input.response as { answer: string }).answer
          : undefined;
      if (!response?.trim()) throw new AgentCommandError("Clarification response must be a non-empty string or {answer} object.");
      let snapshot: ResearchRunSnapshot;
      try {
        snapshot = await agent.answerClarification(runId, response.trim(), input.commandId, input.interruptId, expectedUpdatedAt);
      } catch (error) {
        translateResearchCommandError(error);
      }
      return toServiceSnapshot(runId, snapshot);
    },
    async getSnapshot(threadId, namespace = []) {
      if (namespace.length !== 0) throw new AgentCommandError("Only the root namespace is available for this agent.", 501, "not_supported");
      const runId = threadRuns.get(threadId);
      if (!runId) return undefined;
      const snapshot = await (await getAgent()).get(runId);
      return snapshot ? toServiceSnapshot(runId, snapshot) : undefined;
    },
    async *watch(threadId) {
      const runId = threadRuns.get(threadId);
      if (!runId) return;
      const agent = await getAgent();
      for await (const snapshot of agent.watch(runId)) {
        yield { snapshot: toServiceSnapshot(runId, snapshot) };
      }
    },
    async close() {
      if (agentPromise) await (await agentPromise).close();
    },
  };
  return service;
}

/** Convenience API for callers constructing the HTTP server in-process. */
export function createResearchHostedAgent(options: ResearchAgentServiceOptions = {}): HostedAgent {
  return createHostedAgentAdapter(createResearchAgentService(options));
}

/** Factory used by a local agent-server manifest; the catalog supplies the generic host adapter. */
export async function createResearchAgentFromManifest(context: AgentFactoryContext): Promise<AgentService> {
  return createResearchAgentService({ cwd: context.manifestDirectory, env: context.env });
}

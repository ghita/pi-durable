import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import {
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  type ConversationId,
  type EntryId,
  type TaskId,
  type TaskRuntime,
  type Tx,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { ResearcherDataDoc } from "./tools/researcher-data.ts";
import type { SearchSource } from "./tools/types.ts";

export type RunStatus = "queued" | "running" | "awaiting_clarification" | "completed" | "failed";
export type ClarificationExchange = { question: string; answer: string };

export type RunRecord = {
  runId: string;
  agentId?: string;
  topic: string;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  coordinatorTaskId?: TaskId<CoordinatorResult>;
  config?: ResearchConfig;
  clarificationHistory: ClarificationExchange[];
  pendingQuestion?: string;
  report?: string;
  error?: string;
  phase?: string;
};

export const RunDoc = defineDoc<RunRecord>({
  kind: "app.deep-research.run",
  version: 1,
  scope: "session",
  checkpointWhen: () => true,
  initial: () => ({
    runId: "",
    topic: "",
    status: "queued",
    createdAt: 0,
    updatedAt: 0,
    clarificationHistory: [],
  }),
});

export type ModelChoice = { provider: string; modelId: string };
export type ResearchConfig = {
  allowClarification: boolean;
  maxConcurrentResearchUnits: number;
  maxResearcherIterations: number;
  maxSupervisorRounds: number;
  maxSearchesPerResearcher: number;
  maxTokens: number;
  searchConfigured: boolean;
  model: ModelChoice;
  researchModel: ModelChoice;
  compressionModel: ModelChoice;
  finalReportModel: ModelChoice;
};

export type CoordinatorInput = {
  runId: string;
  topic: string;
  config: ResearchConfig;
  clarificationHistory: ClarificationExchange[];
};

export type CoordinatorResult =
  | { status: "completed"; report: string }
  | { status: "awaiting_clarification"; question: string };

type ResearchState = {
  topic: string;
  history: ClarificationExchange[];
  brief: string;
  rounds: number;
  notes: string[];
  sources: SearchSource[];
  failures: string[];
  completedAssignments: string[];
};
type ResearchChild = { topic: string; conversationId: ConversationId; requestId: string };
type ClarificationCheckpoint = { phase: "clarify"; topic: string; history: ClarificationExchange[] };
type BriefCheckpoint = { phase: "brief"; topic: string; history: ClarificationExchange[] };
type SupervisorCheckpoint = ResearchState & { phase: "supervise" };
type DelegateCheckpoint = ResearchState & { phase: "delegate"; children: ResearchChild[] };
type CompressCheckpoint = ResearchState & {
  phase: "compress";
  rawNotes: string[];
  pendingSources: SearchSource[];
  pendingFailures: string[];
  pendingCompletedAssignments: string[];
};
type ReportCheckpoint = ResearchState & { phase: "report" };
type CoordinatorCheckpoint =
  | ClarificationCheckpoint
  | BriefCheckpoint
  | SupervisorCheckpoint
  | DelegateCheckpoint
  | CompressCheckpoint
  | ReportCheckpoint;

type Runtime = TaskRuntime<CoordinatorInput, CoordinatorCheckpoint, CoordinatorResult, object>;
type RuntimeModel = NonNullable<ReturnType<Runtime["models"]["getModel"]>>;

const prompts = {
  clarification: "Assess whether the user's request needs clarification. Return JSON with needClarification (boolean), question, and verification. Ask only when the scope is genuinely ambiguous; otherwise confirm you have enough information.",
  brief: "Turn the conversation into a detailed research brief. Preserve the user's constraints, audience, time period, geography, language, and requested output. Do not invent missing constraints. Return only the brief.",
  supervisor: "You are a research supervisor. Review the research brief and existing findings, then decide whether the brief is sufficiently covered. Return JSON in exactly this shape: {\"sufficient\":true,\"assignments\":[{\"topic\":\"standalone detailed research instruction\"}]}. Set sufficient=true and assignments=[] when findings adequately cover the brief. When insufficient, return only the most important missing tasks. Do not repeat topics already adequately covered or previously completed. Assignments must be independent and non-overlapping.",
  researcher: "You are a careful web researcher. Investigate the assigned topic using the search tool. Begin with a broad query, then search only for important gaps. Preserve factual details and URLs. Stop when adequately supported; call research_complete with concise findings when ready.",
  compression: "Clean and consolidate the researchers' notes without losing facts, caveats, or sources. Use only URLs present in the retrieved sources. Keep URLs and cite each source inline. End with a Sources section. Return only the cleaned findings.",
  finalReport: "Write a comprehensive answer to the research brief from the findings below. Use clear Markdown headings, distinguish evidence from uncertainty, cite only the retrieved sources as [Title](URL), and do not invent URLs. Disclose material research failures and evidence gaps. Match the user's language, do not mention the internal agents, and end with a Sources section containing only retrieved sources.",
} as const;

function assistantText(message: AssistantMessage | undefined): string {
  return message?.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim() ?? "";
}

function extractJson<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`Expected JSON from model, received: ${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start, end + 1)) as T;
}

function clarificationContext(history: readonly ClarificationExchange[]): string {
  if (history.length === 0) return "";
  return `\n\nClarification exchange so far:\n${history.map(({ question, answer }) => `Question: ${question}\nAnswer: ${answer}`).join("\n")}`;
}

function normalizeAssignment(topic: string): string {
  return topic.trim().toLowerCase().replace(/\s+/g, " ");
}

function setPhase(run: RunRecord, phase: string, now: number): void {
  run.status = "running";
  run.phase = phase;
  run.updatedAt = now;
  delete run.pendingQuestion;
}

type ModelCompletion = { text: string; provider: string; model: string; usage: Usage };

async function complete(
  model: RuntimeModel,
  prompt: string,
  runtime: Runtime,
  context: Context,
  maxTokens: number,
): Promise<ModelCompletion> {
  runtime.signal.throwIfAborted();
  const response = await runtime.models.completeSimple(model, {
    messages: [{ role: "user", content: prompt, timestamp: runtime.now() }],
  }, {
    signal: runtime.signal,
    telemetry: context.telemetry,
    maxTokens,
  });
  if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Model request failed.");
  const text = assistantText(response);
  if (!text) throw new Error("Model returned no text.");
  return { text, provider: response.provider, model: response.model, usage: response.usage };
}

async function recordModelUsage(tx: Tx, conversationId: ConversationId, completion: ModelCompletion): Promise<void> {
  const ledger = await tx.doc(UsageDoc, conversationId);
  const key = `${completion.provider}/${completion.model}`;
  const current = Object.hasOwn(ledger.models, key) ? ledger.models[key] : undefined;
  if (!current) {
    ledger.models[key] = structuredClone(completion.usage);
    return;
  }
  const usage = completion.usage;
  current.input += usage.input;
  current.output += usage.output;
  current.cacheRead += usage.cacheRead;
  current.cacheWrite += usage.cacheWrite;
  current.totalTokens += usage.totalTokens;
  current.cost.input += usage.cost.input;
  current.cost.output += usage.cost.output;
  current.cost.cacheRead += usage.cost.cacheRead;
  current.cost.cacheWrite += usage.cost.cacheWrite;
  current.cost.total += usage.cost.total;
  if (usage.cacheWrite1h !== undefined) current.cacheWrite1h = (current.cacheWrite1h ?? 0) + usage.cacheWrite1h;
  if (usage.reasoning !== undefined) current.reasoning = (current.reasoning ?? 0) + usage.reasoning;
}

function resolveModel(runtime: Runtime, choice: ModelChoice): RuntimeModel {
  const model = runtime.models.getModel(choice.provider, choice.modelId);
  if (!model) throw new Error(`Model not configured: ${choice.provider}/${choice.modelId}`);
  return model;
}

function textFromMessage(message: Message): string {
  if (message.role === "assistant") return assistantText(message);
  if (message.role === "toolResult") {
    return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim();
  }
  return "";
}

function transcriptText(entries: readonly { model?: readonly Message[] }[]): string {
  return entries.flatMap((entry) => (entry.model ?? []).map(textFromMessage)).filter(Boolean).join("\n\n");
}

function entryText(entries: readonly { id: EntryId; model?: readonly Message[] }[], answerId: EntryId): string {
  const entry = entries.find((candidate) => candidate.id === answerId);
  return (entry?.model ?? []).map(textFromMessage).filter(Boolean).join("\n\n");
}

export const CoordinatorTask = defineTask<CoordinatorInput, CoordinatorCheckpoint, CoordinatorResult>({
  name: "app.deep-research.coordinator",
  version: 1,
  initial: (input) => ({ phase: "clarify", topic: input.topic, history: input.clarificationHistory }),
  phases: {
    clarify: async (task, runtime, context) => {
      const { topic, history } = task.state.checkpoint;
      let clarification: ModelCompletion | undefined;
      if (task.input.config.allowClarification) {
        clarification = await complete(
          resolveModel(runtime, task.input.config.model),
          `${prompts.clarification}\n\nRequest:\n${topic}${clarificationContext(history)}`,
          runtime,
          context,
          task.input.config.maxTokens,
        );
        const decision = extractJson<{ needClarification: boolean; question?: string; verification?: string }>(clarification.text);
        if (decision.needClarification && decision.question?.trim()) {
          const question = decision.question.trim();
          await runtime.commit(async (tx) => {
            await recordModelUsage(tx, runtime.conversationId, clarification!);
            const run = await tx.doc(RunDoc);
            run.status = "awaiting_clarification";
            run.phase = "clarify";
            run.pendingQuestion = question;
            run.updatedAt = runtime.now();
            return {
              status: "terminal",
              outcome: { status: "completed", result: { status: "awaiting_clarification", question } },
            };
          }, context);
          return;
        }
      }
      if (!task.input.config.searchConfigured) {
        throw new Error("No web search provider is configured. Set TAVILY_API_KEY before running deep research.");
      }
      await runtime.commit(async (tx) => {
        if (clarification) await recordModelUsage(tx, runtime.conversationId, clarification);
        const run = await tx.doc(RunDoc);
        setPhase(run, "brief", runtime.now());
        return { status: "running", checkpoint: { phase: "brief", topic, history } };
      }, context);
    },
    brief: async (task, runtime, context) => {
      const { topic, history } = task.state.checkpoint;
      const completion = await complete(
        resolveModel(runtime, task.input.config.model),
        `${prompts.brief}\n\nRequest:\n${topic}${clarificationContext(history)}`,
        runtime,
        context,
        task.input.config.maxTokens,
      );
      const brief = completion.text;
      await runtime.commit(async (tx) => {
        await recordModelUsage(tx, runtime.conversationId, completion);
        const run = await tx.doc(RunDoc);
        setPhase(run, "supervise", runtime.now());
        return {
          status: "running",
          checkpoint: {
            phase: "supervise",
            topic,
            history,
            brief,
            rounds: 0,
            notes: [],
            sources: [],
            failures: [],
            completedAssignments: [],
          },
        };
      }, context);
    },
    supervise: async (task, runtime, context) => {
      const state = task.state.checkpoint;
      const completion = await complete(
        resolveModel(runtime, task.input.config.model),
        `${prompts.supervisor}\n\nFor this round, return no more than ${task.input.config.maxConcurrentResearchUnits} assignments. This is the execution limit for the round; do not return extra assignments that will not be scheduled.\n\nResearch brief:\n${state.brief}\n\nExisting findings from earlier delegation:\n${state.notes.join("\n\n")}\n\nPreviously completed assignments:\n${state.completedAssignments.join("\n")}\n\nResearch failures from earlier delegation:\n${state.failures.join("\n")}`,
        runtime,
        context,
        task.input.config.maxTokens,
      );
      const decision = extractJson<{ sufficient: boolean; assignments: { topic: string }[] }>(completion.text);
      const completed = new Set(state.completedAssignments.map(normalizeAssignment));
      const assignments = decision.assignments
        .map(({ topic }) => topic.trim())
        .filter(Boolean)
        .filter((topic) => !completed.has(normalizeAssignment(topic)))
        .slice(0, task.input.config.maxConcurrentResearchUnits);

      if (decision.sufficient || assignments.length === 0) {
        await runtime.commit(async (tx) => {
          await recordModelUsage(tx, runtime.conversationId, completion);
          const run = await tx.doc(RunDoc);
          setPhase(run, "report", runtime.now());
          return { status: "running", checkpoint: { ...state, phase: "report" } };
        }, context);
        return;
      }

      await runtime.commit(async (tx) => {
        await recordModelUsage(tx, runtime.conversationId, completion);
        const children: ResearchChild[] = [];
        const round = state.rounds + 1;
        for (const [index, topic] of assignments.entries()) {
          const child = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
          await configure(tx, child.id, {
            model: task.input.config.researchModel,
            maxTurns: task.input.config.maxResearcherIterations,
            instructions: `${prompts.researcher}\n\nDate: ${new Date(runtime.now()).toISOString().slice(0, 10)}\nAssignment: ${topic}`,
          });
          const researcherData = await tx.doc(ResearcherDataDoc, child.id);
          researcherData.maxSearches = task.input.config.maxSearchesPerResearcher;
          children.push({
            topic,
            conversationId: child.id,
            requestId: `deep-research:${task.input.runId}:round:${round}:unit:${index}`,
          });
        }
        const run = await tx.doc(RunDoc);
        setPhase(run, "research", runtime.now());
        return { status: "running", checkpoint: { ...state, phase: "delegate", rounds: round, children } };
      }, context);
    },
    delegate: async (task, runtime, context) => {
      const state = task.state.checkpoint;
      const results = await Promise.allSettled(state.children.map(async (child) => {
        const conversation = await runtime.conversation(child.conversationId, context);
        if (!conversation) throw new Error(`Researcher conversation for "${child.topic}" is missing.`);
        const request = await conversation.submit(
          { type: "input", content: child.topic, requestId: child.requestId },
          context,
        );
        const settled = await request.wait(context);
        const view = await runtime.context(child.conversationId, context);
        const data = await runtime.snapshot(ResearcherDataDoc, child.conversationId, context);
        const answer = settled.status === "done" && settled.type === "input"
          ? entryText(view.entries, settled.answer)
          : "";
        const findings = data?.findings.trim() || answer || transcriptText(view.entries);
        const sources = [...(data?.sources ?? [])];
        const searchFailure = data?.searchFailures.length
          ? `Web search failed: ${data.searchFailures.join("; ")}`
          : undefined;
        if (settled.status === "done" && settled.type === "input") {
          return { child, findings, sources, completed: true, failure: searchFailure };
        }
        if (settled.status === "unanswered" && settled.reason === "turn_limit" && (findings || sources.length > 0)) {
          const limitFailure = `Research assignment reached its ${task.input.config.maxResearcherIterations}-turn limit; partial findings were retained.`;
          return {
            child,
            findings,
            sources,
            completed: true,
            failure: searchFailure ? `${limitFailure} ${searchFailure}` : limitFailure,
          };
        }
        const reason = settled.status === "unanswered" ? settled.reason : "no answer";
        const failed = `Research assignment failed for "${child.topic}": ${reason}.`;
        return { child, findings, sources, completed: false, failure: searchFailure ? `${failed} ${searchFailure}` : failed };
      }));

      const rawNotes = [...state.notes];
      const sources = [...state.sources];
      const failures = [...state.failures];
      const completedAssignments = [...state.completedAssignments];
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index]!;
        if (result.status === "rejected") {
          failures.push(`Research assignment failed for "${state.children[index]!.topic}": ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
          continue;
        }
        if (result.value.findings) rawNotes.push(`Assignment: ${result.value.child.topic}\n${result.value.findings}`);
        sources.push(...result.value.sources);
        if (result.value.completed) completedAssignments.push(result.value.child.topic);
        if (result.value.failure) failures.push(result.value.failure);
      }

      await runtime.commit(async (tx) => {
        const run = await tx.doc(RunDoc);
        setPhase(run, "compress", runtime.now());
        return {
          status: "running",
          checkpoint: {
            phase: "compress",
            topic: state.topic,
            history: state.history,
            brief: state.brief,
            rounds: state.rounds,
            notes: state.notes,
            sources: state.sources,
            failures: state.failures,
            completedAssignments: state.completedAssignments,
            rawNotes,
            // Intermediate aggregation is committed as the next checkpoint below.
            pendingSources: sources,
            pendingFailures: failures,
            pendingCompletedAssignments: completedAssignments,
          },
        };
      }, context);
    },
    compress: async (task, runtime, context) => {
      const state = task.state.checkpoint;
      const completion = state.rawNotes.length === 0
        ? undefined
        : await complete(
          resolveModel(runtime, task.input.config.compressionModel),
          `${prompts.compression}\n\nDate: ${new Date(runtime.now()).toISOString().slice(0, 10)}\nTopic: ${state.topic}\nRaw findings:\n${state.rawNotes.join("\n\n")}\n\nRetrieved sources:\n${JSON.stringify(state.pendingSources)}`,
          runtime,
          context,
          task.input.config.maxTokens,
        );
      const compressed = completion?.text ?? "";
      await runtime.commit(async (tx) => {
        if (completion) await recordModelUsage(tx, runtime.conversationId, completion);
        const run = await tx.doc(RunDoc);
        const next: ResearchState = {
          topic: state.topic,
          history: state.history,
          brief: state.brief,
          rounds: state.rounds,
          notes: compressed ? [...state.notes, compressed] : state.notes,
          sources: state.pendingSources,
          failures: state.pendingFailures,
          completedAssignments: state.pendingCompletedAssignments,
        };
        const checkpoint: CoordinatorCheckpoint = next.rounds >= task.input.config.maxSupervisorRounds
          ? { ...next, phase: "report" }
          : { ...next, phase: "supervise" };
        setPhase(run, checkpoint.phase, runtime.now());
        return { status: "running", checkpoint };
      }, context);
    },
    report: async (task, runtime, context) => {
      const state = task.state.checkpoint;
      const completion = await complete(
        resolveModel(runtime, task.input.config.finalReportModel),
        `${prompts.finalReport}\n\nDate: ${new Date(runtime.now()).toISOString().slice(0, 10)}\nBrief:\n${state.brief}\n\nFindings:\n${state.notes.join("\n\n")}\n\nResearch failures and evidence gaps:\n${state.failures.join("\n")}\n\nRetrieved sources (cite only these URLs):\n${JSON.stringify(state.sources)}`,
        runtime,
        context,
        task.input.config.maxTokens,
      );
      const report = completion.text;
      await runtime.commit(async (tx) => {
        await recordModelUsage(tx, runtime.conversationId, completion);
        const run = await tx.doc(RunDoc);
        run.status = "completed";
        run.phase = "completed";
        run.report = report;
        run.updatedAt = runtime.now();
        delete run.pendingQuestion;
        return { status: "terminal", outcome: { status: "completed", result: { status: "completed", report } } };
      }, context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(async (tx) => {
      const run = await tx.doc(RunDoc);
      run.status = "running";
      run.updatedAt = runtime.now();
      return { status: "terminal", outcome: { status: "aborted" } };
    }, context);
  },
});

export const ResearchExtension = defineExtension({
  name: "deep-research-workflow",
  tasks: [CoordinatorTask],
});

#!/usr/bin/env node
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { access, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Provider } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { createModels } from "@earendil-works/pi-ai/models";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { createRegistry, Harness, type TaskGraph, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { FileCredentialStore } from "./credentials.ts";
import { CoordinatorTask, ResearchExtension, RunDoc, type ClarificationExchange, type CoordinatorResult, type ModelChoice, type ResearchConfig, type RunRecord } from "./workflow.ts";
import { createResearchToolsExtension, type SearchProvider, type SearchResult } from "./research-tools.ts";
export type { SearchProvider, SearchResult, SearchSource } from "./research-tools.ts";

export type CliIO = {
  stdout(text: string): void;
  stderr(text: string): void;
  ask(question: string): Promise<string>;
};

export type CliDependencies = {
  cwd: string;
  context: Context;
  models: MutableModels;
  model: ModelChoice;
  search: SearchProvider;
  searchConfigured?: boolean;
  io: CliIO;
  env?: NodeJS.ProcessEnv;
};

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class CoordinatorFailure extends Error {}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  const integer = Math.floor(parsed);
  return Number.isSafeInteger(integer) && integer > 0 ? integer : fallback;
}

function boolValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

function normalizeModelId(provider: string, modelId: string): string {
  const prefix = `${provider}/`;
  return provider !== "openrouter" && modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}

function roleModel(env: NodeJS.ProcessEnv, key: string, fallback: ModelChoice): ModelChoice {
  const value = env[key]?.trim();
  if (!value) return fallback;
  for (const provider of ["openai", "openrouter", "github-copilot"]) {
    const explicit = `${provider}:`;
    if (value.startsWith(explicit)) return { provider, modelId: value.slice(explicit.length) };
  }
  return { provider: fallback.provider, modelId: normalizeModelId(fallback.provider, value) };
}

export function researchConfig(env: NodeJS.ProcessEnv, model: ModelChoice, searchConfigured: boolean): ResearchConfig {
  return {
    allowClarification: boolValue(env.ALLOW_CLARIFICATION, true),
    maxConcurrentResearchUnits: positiveNumber(env.MAX_CONCURRENT_RESEARCH_UNITS, 2),
    maxResearcherIterations: positiveNumber(env.MAX_RESEARCHER_ITERATIONS, 3),
    maxSupervisorRounds: positiveNumber(env.MAX_SUPERVISOR_ROUNDS, 1),
    maxSearchesPerResearcher: positiveNumber(env.MAX_SEARCHES_PER_RESEARCHER, 4),
    maxTokens: positiveNumber(env.MAX_TOKENS, 4096),
    searchConfigured,
    model,
    researchModel: roleModel(env, "RESEARCH_MODEL", model),
    compressionModel: roleModel(env, "COMPRESSION_MODEL", model),
    finalReportModel: roleModel(env, "FINAL_REPORT_MODEL", model),
  };
}

function usage(): string {
  return [
    "Usage:",
    '  deep-research "<request>"',
    "  deep-research resume <run-id>",
    "  deep-research list",
  ].join("\n");
}

function normalizeArgs(args: string[]): string[] {
  return args[0] === "--" ? args.slice(1) : args;
}

async function registry(search: SearchProvider, skillsDirectory?: string) {
  const installed = createRegistry();
  installed.install(ResearchExtension);
  installed.install(await createResearchToolsExtension(search, skillsDirectory));
  return installed;
}

async function openRunHarness(path: string, dependencies: CliDependencies, readOnly = false): Promise<Harness> {
  const env = dependencies.env ?? process.env;
  return Harness.open(
    await openNodeSqliteStorage(path),
    { models: dependencies.models, registry: await registry(dependencies.search, env.UI_REACT_SKILLS_DIR), readOnly },
    dependencies.context,
  );
}

async function startCoordinator(
  harness: Harness,
  runId: string,
  topic: string,
  config: ResearchConfig,
  history: ClarificationExchange[],
  context: Context,
  initial: boolean,
): Promise<TaskId<CoordinatorResult>> {
  const root = await harness.root(context, { agent: { model: config.model } });
  return root.commit(async (tx) => {
    const run = await tx.doc(RunDoc);
    if (initial) {
      run.runId = runId;
      run.topic = topic;
      run.createdAt = Date.now();
    }
    run.status = "running";
    run.updatedAt = Date.now();
    run.phase = "clarify";
    run.config = config;
    run.clarificationHistory = history;
    delete run.pendingQuestion;
    const id = await tx.createTask(
      CoordinatorTask,
      { runId, topic, config, clarificationHistory: history },
      { ownership: { kind: "conversation" } },
    );
    run.coordinatorTaskId = id;
    return id;
  }, context);
}

async function watchProgress(harness: Harness, dependencies: CliDependencies): Promise<() => Promise<void>> {
  const watch = await harness.watchTaskGraph(dependencies.context);
  const rendered = new Map<string, string>();
  const show = (graph: TaskGraph): void => {
    for (const node of Object.values(graph.tasks)) {
      const phase = "phase" in node.state ? node.state.phase : node.state.outcome;
      const line = `${node.kind} · ${phase} · ${node.state.status}`;
      if (rendered.get(String(node.id)) === line) continue;
      rendered.set(String(node.id), line);
      dependencies.io.stderr(`Progress: ${line}\n`);
    }
  };
  show(watch.value);
  watch.start(async (call) => {
    if (call.kind === "value") show(call.value);
  });
  return async () => { await watch.stop(); };
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
    throw new CoordinatorFailure(message);
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

function isInterrupted(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || (error as NodeJS.ErrnoException).code === "ABORT_ERR");
}

async function finishOrClarify(
  harness: Harness,
  runId: string,
  initialResult: CoordinatorResult,
  dependencies: CliDependencies,
): Promise<number> {
  let result = initialResult;
  while (result.status === "awaiting_clarification") {
    const run = await harness.snapshot(RunDoc, dependencies.context);
    if (!run?.config) throw new Error("Clarification checkpoint is missing its run configuration.");
    const answer = await dependencies.io.ask(`${result.question}\n> `);
    const history = [...run.clarificationHistory, { question: result.question, answer }];
    const taskId = await startCoordinator(harness, runId, run.topic, run.config, history, dependencies.context, false);
    result = await waitForCoordinator(harness, taskId, dependencies.context);
  }
  dependencies.io.stdout(`${result.report}\n`);
  return 0;
}

async function listRuns(dependencies: CliDependencies): Promise<number> {
  const directory = join(resolve(dependencies.cwd), ".deep-research", "runs");
  let files: string[];
  try {
    files = (await readdir(directory)).filter((file) => file.endsWith(".sqlite")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      dependencies.io.stdout("No research runs.\n");
      return 0;
    }
    throw error;
  }
  const rows: string[] = [];
  for (const file of files) {
    const runId = file.slice(0, -".sqlite".length);
    if (!RUN_ID_PATTERN.test(runId)) continue;
    let harness: Harness | undefined;
    try {
      harness = await openRunHarness(join(directory, file), dependencies, true);
      const run = await harness.snapshot(RunDoc, dependencies.context);
      if (run) rows.push(`${run.runId}\t${run.status}\t${run.topic}`);
    } catch (error) {
      dependencies.io.stderr(`Could not read run ${runId}: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      if (harness) await harness.close(dependencies.context).catch(() => {});
    }
  }
  dependencies.io.stdout(rows.length ? `${rows.join("\n")}\n` : "No research runs.\n");
  return 0;
}

async function resumeRun(runId: string, dependencies: CliDependencies): Promise<number> {
  if (!RUN_ID_PATTERN.test(runId)) {
    dependencies.io.stderr("Run ID must be a UUID printed by deep-research.\n");
    return 2;
  }
  const runDirectory = join(resolve(dependencies.cwd), ".deep-research", "runs");
  const path = join(runDirectory, `${runId}.sqlite`);
  try {
    await access(path);
  } catch {
    dependencies.io.stderr(`No saved run with ID ${runId}.\n`);
    return 2;
  }

  let harness: Harness | undefined;
  let stopProgress: (() => Promise<void>) | undefined;
  try {
    harness = await openRunHarness(path, dependencies);
    const run = await harness.snapshot(RunDoc, dependencies.context);
    if (!run) throw new Error(`Run database ${runId} has no research state.`);
    if (run.status === "completed") {
      dependencies.io.stdout(`${run.report ?? ""}\n`);
      return 0;
    }
    if (run.status === "failed") {
      dependencies.io.stderr(`${run.error ?? "Research run failed."}\n`);
      return 1;
    }
    stopProgress = await watchProgress(harness, dependencies);
    if (run.status === "awaiting_clarification") {
      if (!run.pendingQuestion || !run.config) throw new Error("Clarification checkpoint is incomplete.");
      const answer = await dependencies.io.ask(`${run.pendingQuestion}\n> `);
      const history = [...run.clarificationHistory, { question: run.pendingQuestion, answer }];
      const taskId = await startCoordinator(harness, run.runId, run.topic, run.config, history, dependencies.context, false);
      return await finishOrClarify(harness, runId, await waitForCoordinator(harness, taskId, dependencies.context), dependencies);
    }
    if (!run.coordinatorTaskId || !run.config) throw new Error("Saved run is missing its coordinator task.");
    const result = await waitForCoordinator(
      harness,
      run.coordinatorTaskId,
      dependencies.context,
    );
    return await finishOrClarify(harness, runId, result, dependencies);
  } catch (error) {
    if (isInterrupted(error)) {
      dependencies.io.stderr(`Stopped. Resume with: deep-research resume ${runId}\n`);
      return 130;
    }
    if (error instanceof CoordinatorFailure && harness) await markRunFailed(harness, error, dependencies.context).catch(() => {});
    dependencies.io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    if (stopProgress) await stopProgress().catch(() => {});
    if (harness) await harness.close(dependencies.context).catch(() => {});
  }
}

export async function runCli(args: string[], dependencies: CliDependencies): Promise<number> {
  const normalized = normalizeArgs(args);
  if (normalized.includes("--help") || normalized.includes("-h")) {
    dependencies.io.stdout(`${usage()}\n`);
    return 0;
  }
  if (normalized[0] === "list") return await listRuns(dependencies);
  if (normalized[0] === "resume") {
    if (!normalized[1] || normalized.length !== 2) {
      dependencies.io.stderr("Usage: deep-research resume <run-id>\n");
      return 2;
    }
    return await resumeRun(normalized[1], dependencies);
  }

  const topic = normalized.join(" ").trim();
  if (!topic) {
    dependencies.io.stderr(`${usage()}\n`);
    return 2;
  }

  const runId = randomUUID();
  const runDirectory = join(resolve(dependencies.cwd), ".deep-research", "runs");
  await mkdir(runDirectory, { recursive: true });
  dependencies.io.stderr(`Run ID: ${runId}\n`);

  let harness: Harness | undefined;
  let stopProgress: (() => Promise<void>) | undefined;
  try {
    const env = dependencies.env ?? process.env;
    const config = researchConfig(env, dependencies.model, dependencies.searchConfigured ?? Boolean(env.TAVILY_API_KEY?.trim()));
    harness = await openRunHarness(join(runDirectory, `${runId}.sqlite`), dependencies);
    stopProgress = await watchProgress(harness, dependencies);
    const taskId = await startCoordinator(harness, runId, topic, config, [], dependencies.context, true);
    const result = await waitForCoordinator(harness, taskId, dependencies.context);
    return await finishOrClarify(harness, runId, result, dependencies);
  } catch (error) {
    if (isInterrupted(error)) {
      dependencies.io.stderr(`Stopped. Resume with: deep-research resume ${runId}\n`);
      return 130;
    }
    if (error instanceof CoordinatorFailure && harness) await markRunFailed(harness, error, dependencies.context).catch(() => {});
    dependencies.io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    if (stopProgress) await stopProgress().catch(() => {});
    if (harness) await harness.close(dependencies.context).catch(() => {});
  }
}

function withModelDefaults<TApi extends string>(
  provider: Provider<TApi>,
  maxTokens: number,
  overrides: { baseUrl?: string; headers?: Record<string, string> } = {},
): Provider<TApi> {
  const getModels = provider.getModels.bind(provider);
  return {
    ...provider,
    ...overrides,
    getModels: () => getModels().map((model) => ({
      ...model,
      maxTokens: model.maxTokens > 0 ? Math.min(model.maxTokens, maxTokens) : maxTokens,
    })),
  };
}

function configuredModels(env: NodeJS.ProcessEnv): MutableModels {
  const credentials = new FileCredentialStore(env.COPILOT_AUTH_FILE?.trim() || undefined);
  const models = createModels({ credentials });
  const maxTokens = positiveNumber(env.MAX_TOKENS, 4096);
  const openrouter = openrouterProvider();
  models.setProvider(withModelDefaults(openrouter, maxTokens, {
    baseUrl: env.OPENROUTER_BASE_URL ?? openrouter.baseUrl,
    headers: {
      ...openrouter.headers,
      ...(env.OPENROUTER_HTTP_REFERER ? { "HTTP-Referer": env.OPENROUTER_HTTP_REFERER } : {}),
      "X-Title": "Deep Research CLI",
    },
  }));
  const openai = openaiProvider();
  models.setProvider(withModelDefaults(openai, maxTokens, { baseUrl: env.OPENAI_BASE_URL ?? openai.baseUrl }));
  models.setProvider(withModelDefaults(githubCopilotProvider(), maxTokens));
  return models;
}

function defaultModel(env: NodeJS.ProcessEnv): ModelChoice {
  const requested = env.MODEL_PROVIDER;
  const explicitProvider = requested === "openai" || requested === "openrouter" || requested === "github-copilot"
    ? requested
    : undefined;
  const modelId = explicitProvider === "github-copilot"
    ? env.COPILOT_MODEL ?? "gpt-5-mini"
    : env.OPENROUTER_MODEL ?? env.OPENAI_MODEL ?? "gpt-4o-mini";
  const looksOpenRouter = Boolean(env.OPENROUTER_MODEL || env.OPENROUTER_API_KEY) || modelId.startsWith("openai/") || modelId.startsWith("openrouter/");
  const provider = explicitProvider ?? (looksOpenRouter ? "openrouter" : "openai");
  return { provider, modelId: normalizeModelId(provider, modelId) };
}

async function tavilySearch(query: string, context: Context): Promise<SearchResult> {
  const key = process.env.TAVILY_API_KEY?.trim();
  if (!key) return { ok: false, error: "TAVILY_API_KEY is not configured." };
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query,
        topic: process.env.TAVILY_TOPIC ?? "general",
        max_results: positiveNumber(process.env.TAVILY_MAX_RESULTS, 5),
        include_answer: false,
      }),
      signal: context.abortSignal
        ? AbortSignal.any([context.abortSignal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
    if (!response.ok) return { ok: false, error: `Tavily search failed (${response.status}): ${(await response.text()).slice(0, 500)}` };
    const body = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return {
      ok: true,
      results: (body.results ?? []).map((item) => ({
        title: item.title ?? "Untitled",
        url: item.url ?? "",
        content: item.content ?? "",
        query,
      })),
    };
  } catch (error) {
    return { ok: false, error: `Tavily search failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function main(): Promise<void> {
  const env = process.env;
  const code = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    context: BACKGROUND_CONTEXT,
    models: configuredModels(env),
    model: defaultModel(env),
    search: tavilySearch,
    searchConfigured: Boolean(env.TAVILY_API_KEY?.trim()),
    io: {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      ask: async (question) => {
        process.stderr.write(question);
        const readline = await import("node:readline/promises");
        const terminal = readline.createInterface({ input: process.stdin, output: process.stderr });
        const interrupted = new AbortController();
        terminal.once("SIGINT", () => interrupted.abort());
        try {
          return await terminal.question("", { signal: interrupted.signal });
        } catch (error) {
          if (interrupted.signal.aborted) {
            const abort = new Error("Terminal input interrupted.");
            abort.name = "AbortError";
            throw abort;
          }
          throw error;
        } finally {
          terminal.close();
        }
      },
    },
  });
  process.exitCode = code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

import type { Provider } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { createModels } from "@earendil-works/pi-ai/models";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { Context } from "@earendil-works/chord/context";
import { FileCredentialStore } from "./credentials.ts";
import type { ModelChoice, ResearchConfig } from "./workflow.ts";
import type { SearchProvider, SearchResult } from "./research-tools.ts";

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
      "X-Title": "Deep Research Agent",
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

function tavilySearch(env: NodeJS.ProcessEnv): SearchProvider {
  return async (query: string, context: Context): Promise<SearchResult> => {
    const key = env.TAVILY_API_KEY?.trim();
    if (!key) return { ok: false, error: "TAVILY_API_KEY is not configured." };
    try {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: key,
          query,
          topic: env.TAVILY_TOPIC ?? "general",
          max_results: positiveNumber(env.TAVILY_MAX_RESULTS, 5),
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
  };
}

export type ResearchRuntime = {
  models: MutableModels;
  model: ModelChoice;
  search: SearchProvider;
  searchConfigured: boolean;
};

export function createResearchRuntime(env: NodeJS.ProcessEnv = process.env): ResearchRuntime {
  return {
    models: configuredModels(env),
    model: defaultModel(env),
    search: tavilySearch(env),
    searchConfigured: Boolean(env.TAVILY_API_KEY?.trim()),
  };
}

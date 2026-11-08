import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { runCli } from "../src/cli-adapter.ts";
import { createResearchRunAgent } from "../src/research-run-agent.ts";

type SearchSource = { title: string; url: string; content: string; query: string };
type Search = (query: string) => Promise<{ ok: true; results: SearchSource[] }>;

function dependencies(
  directory: string,
  responses: (string | AssistantMessage | FauxResponseFactory)[],
  defaultAnswer: (question: string) => Promise<string> = async () => "Focus on Europe.",
  search: Search = async (query) => ({ ok: true, results: [{ title: "Search result", url: "https://example.test/source", content: "Search evidence", query }] }),
  env: NodeJS.ProcessEnv = {},
  searchConfigured = true,
) {
  const faux = fauxProvider();
  faux.setResponses(responses.map((response) => typeof response === "string" ? fauxAssistantMessage([fauxText(response)]) : response) as FauxResponseStep[]);
  const models = createModels();
  models.setProvider(faux.provider);
  let stdout = "";
  let stderr = "";
  const questions: string[] = [];
  let agentPromise: ReturnType<typeof createResearchRunAgent> | undefined;
  const getAgent = () => agentPromise ??= createResearchRunAgent({
    cwd: directory,
    context: BACKGROUND_CONTEXT,
    models,
    model: { provider: "faux", modelId: "faux-1" },
    search: (query) => search(query),
    searchConfigured,
    env,
  });
  return {
    models,
    faux,
    questions,
    getAgent,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    close: async () => { if (agentPromise) await (await agentPromise).close(); },
    run: async (args: string[], answer = defaultAnswer) => runCli(args, {
      agent: await getAgent(),
      io: {
        stdout: (text) => { stdout += text; },
        stderr: (text) => { stderr += text; },
        ask: async (question) => {
          questions.push(question);
          return answer(question);
        },
      },
    }),
  };
}

const directReportResponses = [
  '{"needClarification":false,"question":"","verification":""}',
  "A brief about battery recycling.",
  '{"sufficient":true,"assignments":[]}',
  "# Battery recycling\n\nHere is the report.",
];

test("ResearchRunAgent accepts work asynchronously and watches high-level progress", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deep-research-agent-api-"));
  const app = dependencies(directory, directReportResponses);
  try {
    const agent = await app.getAgent();
    const agents = await agent.listAgents();
    assert.equal(agents[0]?.id, "deep-research");

    const started = await agent.start({ agentId: agents[0]!.id, request: "Research current battery recycling methods" });
    assert.equal(started.status, "running");
    assert.equal(started.request, "Research current battery recycling methods");

    const resumed = await agent.resume(started.runId);
    assert.equal(resumed.runId, started.runId);
    const updates = [];
    for await (const snapshot of agent.watch(started.runId)) updates.push(snapshot);
    const completed = updates.at(-1);
    assert.equal(completed?.status, "completed");
    assert.match(completed?.report ?? "", /# Battery recycling/);
    assert.ok(updates.some((snapshot) => snapshot.phase === "writing_report"));
    assert.ok(updates.every((snapshot) => !["supervise", "compress", "report"].includes(snapshot.phase ?? "")));
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a positional request runs research, prints a run ID, and writes the report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deep-research-cli-"));
  const app = dependencies(directory, directReportResponses);
  try {
    const exitCode = await app.run(["Research current battery recycling methods"]);
    assert.equal(exitCode, 0);
    assert.match(app.stderr, /Run ID: [0-9a-f-]+/i);
    assert.match(app.stdout, /# Battery recycling/);
    assert.match(app.stdout, /Here is the report\./);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a clarification question is asked in the terminal and the same run continues", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deep-research-clarification-"));
  const app = dependencies(directory, [
    '{"needClarification":true,"question":"Which region should I focus on?","verification":""}',
    '{"needClarification":false,"question":"","verification":"Europe"}',
    "A Europe-focused brief.",
    '{"sufficient":true,"assignments":[]}',
    "# Europe battery recycling\n\nThe report.",
  ]);
  try {
    const exitCode = await app.run(["Research battery recycling"]);
    assert.equal(exitCode, 0);
    assert.equal(app.questions.length, 1);
    assert.match(app.questions[0]!, /Which region should I focus on/);
    assert.match(app.stdout, /# Europe battery recycling/);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an interrupted clarification is re-asked by explicit run ID and the saved run completes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deep-research-resume-"));
  const app = dependencies(directory, [
    '{"needClarification":true,"question":"Which region should I focus on?","verification":""}',
  ]);
  try {
    const interrupted = await app.run(["Research battery recycling"], async () => {
      const error = new Error("terminal interrupted");
      error.name = "AbortError";
      throw error;
    });
    assert.equal(interrupted, 130);
    const runId = /Run ID: ([0-9a-f-]+)/i.exec(app.stderr)?.[1];
    assert.ok(runId);

    app.faux.appendResponses([
      fauxAssistantMessage([fauxText('{"needClarification":false,"question":"","verification":"Europe"}')]),
      fauxAssistantMessage([fauxText("A Europe-focused brief.")]),
      fauxAssistantMessage([fauxText('{"sufficient":true,"assignments":[]}')]),
      fauxAssistantMessage([fauxText("# Europe battery recycling\n\nThe saved run resumed.")]),
    ]);
    const resumed = await app.run(["resume", runId], async () => "Europe");
    assert.equal(resumed, 0);
    assert.equal(app.questions.length, 2);
    assert.match(app.questions[1]!, /Which region should I focus on/);
    assert.match(app.stdout, /The saved run resumed\./);

    const listed = await app.run(["list"]);
    assert.equal(listed, 0);
    assert.match(app.stdout, new RegExp(`${runId}\\tcompleted`));
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the supervisor delegates to a durable researcher conversation and passes its sources to the report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deep-research-delegation-"));
  const queries: string[] = [];
  const app = dependencies(directory, [
    "Research battery recycling in Europe.",
    '{"sufficient":false,"assignments":[{"topic":"Current European battery recycling methods"}]}',
    fauxAssistantMessage([fauxToolCall("tavily_search", { query: "European battery recycling" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Lithium-ion battery recycling is expanding across Europe.")]),
    fauxAssistantMessage([fauxText("Europe is expanding lithium-ion battery recycling, supported by the retrieved source.")]),
    fauxAssistantMessage([fauxText("# Europe\n\nEuropean recycling is expanding.\n\nSources: [Search result](https://example.test/source)")]),
  ], undefined, async (query) => {
    queries.push(query);
    return {
      ok: true,
      results: [{ title: "Search result", url: "https://example.test/source", content: "European recycling evidence", query }],
    };
  }, {
    ALLOW_CLARIFICATION: "false",
    MAX_SUPERVISOR_ROUNDS: "1",
    MAX_CONCURRENT_RESEARCH_UNITS: "2",
    MAX_RESEARCHER_ITERATIONS: "2",
    MAX_SEARCHES_PER_RESEARCHER: "2",
  });
  try {
    const exitCode = await app.run(["Research battery recycling in Europe"]);
    assert.equal(exitCode, 0, app.stderr);
    assert.deepEqual(queries, ["European battery recycling"]);
    assert.match(app.stdout, /European recycling is expanding/);
    assert.match(app.stdout, /https:\/\/example\.test\/source/);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a researcher cannot exceed its persisted Tavily search budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deep-research-search-limit-"));
  const queries: string[] = [];
  const app = dependencies(directory, [
    "Research the topic.",
    '{"sufficient":false,"assignments":[{"topic":"Research the topic"}]}',
    fauxAssistantMessage([fauxToolCall("tavily_search", { query: "first search" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("tavily_search", { query: "second search" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Compressed evidence from the first search.")]),
    fauxAssistantMessage([fauxText("Final report with one source.")]),
  ], undefined, async (query) => {
    queries.push(query);
    return { ok: true, results: [{ title: "One source", url: "https://example.test/one", content: "Evidence", query }] };
  }, {
    ALLOW_CLARIFICATION: "false",
    MAX_SUPERVISOR_ROUNDS: "1",
    MAX_RESEARCHER_ITERATIONS: "3",
    MAX_SEARCHES_PER_RESEARCHER: "1",
  });
  try {
    assert.equal(await app.run(["Research the topic"]), 0, app.stderr);
    assert.deepEqual(queries, ["first search"]);
    assert.match(app.stdout, /Final report with one source/);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a researcher hitting its turn limit still contributes partial findings to compression", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deep-research-turn-limit-"));
  const queries: string[] = [];
  const app = dependencies(directory, [
    "Research the topic.",
    '{"sufficient":false,"assignments":[{"topic":"Research the topic"}]}',
    fauxAssistantMessage([fauxToolCall("tavily_search", { query: "limited search" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Compressed partial evidence.")]),
    fauxAssistantMessage([fauxText("Final report with partial findings.")]),
  ], undefined, async (query) => {
    queries.push(query);
    return { ok: true, results: [{ title: "Partial source", url: "https://example.test/partial", content: "Partial evidence", query }] };
  }, {
    ALLOW_CLARIFICATION: "false",
    MAX_SUPERVISOR_ROUNDS: "1",
    MAX_RESEARCHER_ITERATIONS: "1",
    MAX_SEARCHES_PER_RESEARCHER: "4",
  });
  try {
    assert.equal(await app.run(["Research the topic"]), 0, app.stderr);
    assert.deepEqual(queries, ["limited search"]);
    assert.match(app.stdout, /Final report with partial findings/);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed researcher does not discard its successful sibling's findings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deep-research-partial-failure-"));
  const queries: string[] = [];
  const compressionPrompts: string[] = [];
  const reportPrompts: string[] = [];
  const researcherRoute: FauxResponseFactory = (request) => {
    const prompt = JSON.stringify(request.messages);
    if (prompt.includes("Failing assignment")) {
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: "simulated model failure" });
    }
    if (request.messages.some((message) => message.role === "toolResult" && message.toolName === "tavily_search")) {
      return fauxAssistantMessage([fauxText("Successful researcher found a relevant recycling program.")]);
    }
    return fauxAssistantMessage([fauxToolCall("tavily_search", { query: "successful sibling query" })], { stopReason: "toolUse" });
  };
  const compression: FauxResponseFactory = (request) => {
    compressionPrompts.push(JSON.stringify(request.messages));
    return fauxAssistantMessage([fauxText("Compressed successful researcher findings.")]);
  };
  const finalReport: FauxResponseFactory = (request) => {
    reportPrompts.push(JSON.stringify(request.messages));
    return fauxAssistantMessage([fauxText("Report includes the successful sibling and discloses a research failure.")]);
  };
  const app = dependencies(directory, [
    "Brief for two independent research units.",
    '{"sufficient":false,"assignments":[{"topic":"Failing assignment"},{"topic":"Successful assignment"}]}',
    researcherRoute,
    researcherRoute,
    researcherRoute,
    compression,
    finalReport,
  ], undefined, async (query) => {
    queries.push(query);
    return { ok: true, results: [{ title: "Good source", url: "https://example.test/good", content: "Good evidence", query }] };
  }, {
    ALLOW_CLARIFICATION: "false",
    MAX_SUPERVISOR_ROUNDS: "1",
    MAX_CONCURRENT_RESEARCH_UNITS: "2",
    MAX_RESEARCHER_ITERATIONS: "2",
    MAX_SEARCHES_PER_RESEARCHER: "2",
  });
  try {
    assert.equal(await app.run(["Research two related topics"]), 0, app.stderr);
    assert.deepEqual(queries, ["successful sibling query"]);
    assert.match(compressionPrompts.join("\n"), /Successful researcher found a relevant recycling program/);
    assert.match(reportPrompts.join("\n"), /Research assignment failed for/);
    assert.match(app.stdout, /discloses a research failure/);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing Tavily is reported as a failed saved run before briefing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deep-research-no-search-"));
  const app = dependencies(directory, [
    '{"needClarification":false,"question":"","verification":""}',
  ], undefined, undefined, {}, false);
  try {
    const exitCode = await app.run(["Research without a search key"]);
    assert.equal(exitCode, 1);
    assert.match(app.stderr, /TAVILY_API_KEY/);
    assert.equal(await app.run(["list"]), 0);
    assert.match(app.stdout, /failed/);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("research_complete terminates a researcher conversation early", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deep-research-early-complete-"));
  const compressionPrompts: string[] = [];
  const app = dependencies(directory, [
    "Research the topic.",
    '{"sufficient":false,"assignments":[{"topic":"Research the topic"}]}',
    fauxAssistantMessage([fauxToolCall("research_complete", { findings: "Early findings from the researcher." })], { stopReason: "toolUse" }),
    (request) => {
      compressionPrompts.push(JSON.stringify(request.messages));
      return fauxAssistantMessage([fauxText("Compressed early findings.")]);
    },
    fauxAssistantMessage([fauxText("Final report from early findings.")]),
  ], undefined, async () => {
    throw new Error("Search should not be needed when research_complete is called first.");
  }, {
    ALLOW_CLARIFICATION: "false",
    MAX_SUPERVISOR_ROUNDS: "1",
    MAX_RESEARCHER_ITERATIONS: "3",
    MAX_SEARCHES_PER_RESEARCHER: "2",
  });
  try {
    assert.equal(await app.run(["Research the topic"]), 0, app.stderr);
    assert.match(compressionPrompts.join("\\n"), /Early findings from the researcher/);
    assert.match(app.stdout, /Final report from early findings/);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("each research run uses its own SQLite file and run ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deep-research-isolation-"));
  const app = dependencies(directory, [...directReportResponses, ...directReportResponses]);
  try {
    assert.equal(await app.run(["First independent research request"]), 0);
    assert.equal(await app.run(["Second independent research request"]), 0);
    const ids = [...app.stderr.matchAll(/Run ID: ([0-9a-f-]+)/gi)].map((match) => match[1]);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
    assert.equal(await app.run(["list"]), 0);
    assert.match(app.stdout, new RegExp(`${ids[0]}\\tcompleted\\tFirst independent research request`));
    assert.match(app.stdout, new RegExp(`${ids[1]}\\tcompleted\\tSecond independent research request`));
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

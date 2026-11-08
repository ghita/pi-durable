# Durable Deep Research Agent

A durable deep-research workflow built with `@earendil-works/pi-durable`, exposed as an in-process `ResearchRunAgent` service and a CLI adapter. The workflow keeps the research supervisor deterministic, while each researcher uses Durable's built-in conversation/tool loop.

## Requirements and setup

- Node.js 22.19 or newer
- A model provider credential and a Tavily API key

```sh
npm install
cp .env.example .env
# Fill in provider credentials and TAVILY_API_KEY in .env
npm run build
```

On Windows PowerShell, copy the example with `Copy-Item .env.example .env`.

## Commands

Start one run (the request is the positional argument):

```sh
npm run cli -- "Research current battery recycling methods"
```

The CLI prints the durable run ID, shows high-level progress on stderr, and writes the final Markdown report to stdout. If clarification is needed, it asks in the terminal. Ctrl-C leaves the saved run resumable.

```sh
npm run cli -- resume <run-id>
npm run cli -- list
```

`resume` reopens only that run. If it was waiting for clarification, the CLI asks the saved question again. If it already completed, it prints the stored report. `list` prints saved run IDs, status, and request topic.

For an installed executable, run `npm link` after `npm run build`, then use `deep-research "..."`, `deep-research resume <run-id>`, or `deep-research list`.

## In-process service

The CLI uses the same service contract available to an in-process host. `createResearchRunAgent()` reads the existing environment-based configuration internally and recovers saved running runs when opened.

```ts
import { createResearchRunAgent } from "deep-research-durable-cli";

const agent = await createResearchRunAgent();
try {
  const [deepResearch] = await agent.listAgents();
  const run = await agent.start({
    agentId: deepResearch!.id,
    request: "Research current battery recycling methods",
  });

  let snapshot = run;
  while (true) {
    for await (const update of agent.watch(run.runId)) snapshot = update;
    if (snapshot.status !== "awaiting_clarification") break;
    // Obtain an answer from the host UI, then continue the same run.
    snapshot = await agent.answerClarification(run.runId, "Focus on Europe.");
  }
  if (snapshot.status === "completed") console.log(snapshot.report);
} finally {
  await agent.close();
}
```

`start` returns after the run is durably accepted; work continues independently of the caller's connection. `watch` yields high-level run snapshots, and ends when clarification is needed or the run reaches a terminal state. `resume(runId)` reattaches to or recovers the same run; it does not retry completed or failed runs. `close()` waits for active runs to settle. HTTP/IPC adapters are not included yet.

## Persistence and privacy

Each run gets an isolated SQLite database under `.deep-research/runs/<run-id>.sqlite`. The directory is git-ignored; it contains the prompt, clarification answers, findings, sources, task checkpoints, and report. Keep it local and protect it as user data. SQLite-backed Durable state survives ordinary process exits/crashes; a request interrupted inside an LLM call may be retried on resume.

## Configuration

Configuration is environment-based to match the existing research agent. The CLI loads `.env` automatically; an in-process or server host should populate `process.env` before creating the service.

- Provider/model: `MODEL_PROVIDER` (`openai`, `openrouter`, or `github-copilot`), `OPENAI_MODEL`, `OPENROUTER_MODEL`, or `COPILOT_MODEL`.
- Provider credentials: `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or `COPILOT_GITHUB_TOKEN`. Copilot OAuth can reuse the existing `COPILOT_AUTH_FILE` credential file; otherwise the default is `%APPDATA%/ui-react/copilot-auth.json` on Windows or `$XDG_CONFIG_HOME/ui-react/copilot-auth.json` on Unix-like systems.
- Optional provider settings: `OPENAI_BASE_URL`, `OPENROUTER_BASE_URL`, `OPENROUTER_HTTP_REFERER`.
- Search: `TAVILY_API_KEY`, `TAVILY_TOPIC` (`general`, `news`, or `finance`), `TAVILY_MAX_RESULTS`.
- Workflow limits: `ALLOW_CLARIFICATION`, `MAX_CONCURRENT_RESEARCH_UNITS`, `MAX_RESEARCHER_ITERATIONS`, `MAX_SUPERVISOR_ROUNDS`, `MAX_SEARCHES_PER_RESEARCHER`, `MAX_TOKENS`.
- Optional project skills: `UI_REACT_SKILLS_DIR`. Skill files are exposed to researcher conversations read-only through `load_skill` and `read_skill_file`.

Researcher turn limits and Tavily search limits are enforced separately: Durable's `maxTurns` caps tool rounds; a persisted per-researcher counter caps searches. The supervisor caps concurrency and rounds, waits for all researchers, and retains successful findings if a sibling fails. Coordinator model calls are recorded in Durable's `pi.usage` document, while researcher conversation/tool usage uses Durable's built-in accounting.

## Development

```sh
npm test
npm run typecheck
npm run build
```

The integration tests use Durable's faux model provider and injected search responses; they do not call a live LLM or Tavily.

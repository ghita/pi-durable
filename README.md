# Durable Deep Research Agent

A durable deep-research workflow built with `@earendil-works/pi-durable`, hosted by the HTTP agent server and operated through the protocol-based CLI or typed client. The workflow keeps the research supervisor deterministic, while each researcher uses Durable's built-in conversation/tool loop. The CLI is an HTTP client only; it never creates or calls an in-process agent.

## Requirements and setup

- Node.js 22.19 or newer
- A model provider credential (Tavily API key is needed only for Deep Research)

```sh
npm install
cp .env.example .env
# Fill in provider credentials and TAVILY_API_KEY in .env
npm run build
```

On Windows PowerShell, copy the example with `Copy-Item .env.example .env`.

## CLI commands

Use the root `README.md` as the end-to-end quick start. Configure `.env` and the manifest as described in [Agent server](#agent-server), then use two terminals.

**Terminal 1 — start the HTTP server** (copy the example manifest once):

```sh
cp agent-server.example.json agent-server.json
npm run server
```

**Terminal 2 — discover and run agents through HTTP:**

```sh
npm run cli -- agents
npm run cli -- run --agent deep-research --input-json '{"request":"Research current battery recycling methods"}'
npm run cli -- chat --agent simple-chat --input-json '{"message":"What is Pi Durable?"}'
npm run cli -- list
npm run cli -- resume <thread-id>
```

Every `run` or `chat` invocation must explicitly select an agent and provide JSON input; the CLI has no default or agent-specific behavior. `run` starts one turn and exits. For a `multi-turn` agent, `chat` starts with the supplied JSON input, then prompts for another JSON input after each terminal turn; a blank line exits. It reuses the same thread and works for any catalog agent with `threadPolicy: "multi-turn"`. `run` remains useful for one-shot or scripted calls. To invoke any catalog agent, use its ID and input shape from the descriptor:

```sh
npm run cli -- run --agent <agent-id> --input-json '<JSON matching the descriptor input schema>'
```

The CLI discovers agents, creates a bound thread, sends `run.start`, consumes protocol events over SSE, and answers `input.requested` events with `input.respond` while preserving event namespaces. It prints the thread ID, progress to stderr, and agent results to stdout. Interactive `chat` asks for each next turn as JSON matching the agent's input schema; blank input exits. The CLI currently answers one pending input at a time; multi-interrupt batches are not supported. Ctrl-C leaves durable server work running; use `deep-research resume <thread-id>` to reconnect. `list` lists server threads, and `agents` discovers the server catalog.

For an installed executable, run `npm link` after `npm run build`. Configure `AGENT_SERVER_URL` and `AGENT_SERVER_TOKEN` in the CLI environment. The CLI does not construct, import, or call `ResearchRunAgent` directly.

## In-process service (library API only)

Applications embedding the research workflow can still use `createResearchRunAgent()` directly. The command-line client deliberately does not use this API; all CLI runs go through the server and protocol.

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

`start` returns after the run is durably accepted; work continues independently of the caller's connection. `watch` yields high-level run snapshots, and ends when clarification is needed or the run reaches a terminal state. `resume(runId)` reattaches to or recovers the same run; it does not retry completed or failed runs. `close()` waits for active runs to settle.

## Agent server

The package also provides a local HTTP server that hosts a configured catalog of agent services through a shared `HostedAgent` protocol adapter. It persists server-owned thread identity/binding and command-idempotency records under `.agent-server/server-state.json`; agent workflow checkpoints remain in the agent's own store. A thread stays bound to its creating agent. The research service declares `single-case`: create a new thread for each case, and answer clarifications through `input.respond` on that same thread.

Create a manifest and configure a bearer token:

```sh
cp agent-server.example.json agent-server.json
cp .env.example .env
# Set AGENT_SERVER_TOKEN (at least 16 characters), provider credentials, and TAVILY_API_KEY in .env
npm run server
```

The manifest's `agents` map is an explicit trusted local module-export catalog. Module paths are relative to the manifest. Catalog changes require a restart. Example manifest entries use the built `dist/` output; the server script builds before launch. The server binds to `127.0.0.1` by default and requires `AGENT_SERVER_TOKEN`. A non-loopback bind is supported behind a TLS-terminating reverse proxy: it requires `AGENT_SERVER_TRUST_PROXY=true`, `AGENT_SERVER_TRUSTED_PROXY_ADDRESSES` set to the proxy's source IP address(es), and the proxy must set `X-Forwarded-Proto: https`. Direct remote HTTP is rejected; direct TLS serving is not enabled by this executable. The bearer token grants execution with the server process's privileges; adapters are trusted code, not sandboxed plugins.

An `AgentService` provides a descriptor, idempotent thread creation/restoration, `startRun`, `respond`, `getSnapshot`, `watch`, and `close`. It should use the host thread ID as its durable conversation key when supported; otherwise `createThread` can return an opaque reference that the host persists for reattachment. `startRun` and `respond` receive stable command IDs and must deduplicate retries. `watch` yields full run snapshots (status, progress, pending inputs, output, or error) plus optional domain events. The shared adapter turns these into lifecycle, input, progress, result, and state protocol messages. A multi-turn thread allows successive runs after a run completes or fails; each run can pause on multiple pending inputs, answered individually. A new run cannot replace an interrupted one. Cancellation is not part of v1: disconnecting a client leaves durable work running.

The v1 HTTP routes are `GET /v1/agents`, `GET /v1/agents/:agentId`, `POST /v1/threads`, `GET /v1/threads`, `GET /v1/threads/:threadId`, `POST /v1/threads/:threadId/commands`, and `POST /v1/threads/:threadId/stream` (SSE). `POST /v1/threads/:id/commands` accepts the pinned `@langchain/protocol` command envelope; v1 implements `run.start`, `input.respond`, and adapter-owned `state.get`. For example:

```ts
import { AgentServerClient } from "deep-research-durable-cli/agent-server";

const client = new AgentServerClient({ baseUrl: "http://127.0.0.1:3000", token: process.env.AGENT_SERVER_TOKEN! });
const [agent] = await client.listAgents();
const thread = await client.createThread({ agentId: agent!.id });
await client.startRun(thread.threadId, agent!.id, { request: "Research current battery recycling methods" });

// Read thread status for a fresh snapshot after attaching/reconnecting, then stream updates.
for await (const event of client.stream(thread.threadId, { channels: ["lifecycle", "input", "custom"] })) {
  console.log(event);
  if (event.method === "input.requested") {
    const params = event.params as { data: { interrupt_id: string; payload: { question: string } } };
    await client.respond(thread.threadId, params.data.interrupt_id, "Focus on Europe.");
  }
  if (event.method === "lifecycle" && ["completed", "failed"].includes((event.params as { data: { event: string } }).data.event)) break;
}
```

For multi-turn chat, create one `simple-chat` thread and call `client.startRun(thread.threadId, "simple-chat", { message })` for each message after the previous run reaches a terminal status. The same Durable transcript is reused, including after the server reopens the thread.

A supplied thread ID conflicts by default; `ifExists: "do_nothing"` attaches only if the existing thread is bound to the requested agent. Protocol command IDs are scoped to a thread: retry an ambiguously completed command with the same `id` and identical body to receive its cached response; reusing the ID with a different body conflicts. Use `client.allocateCommandId()` before sending if you must persist an ID for a retry; automatically allocated IDs are randomized per client instance. Retry-safe admission rejections are not cached. An adapter must make command admission idempotent for stable IDs. SSE event IDs are per-thread sequence cursors with a bounded in-memory replay buffer; expired cursors return `409` with the current `eventCursor`. After a restart or replay-window expiry, read the thread and agent state snapshots before resuming from the current cursor. Closing a stream does not cancel durable work. One process owns the local server state directory.

`loadAgentCatalog(manifestPath)` and `createAgentServer({ catalog, token, ... })` compose the library directly. Additional agents export a factory returning an `AgentService`; the catalog wraps each service in the shared `HostedAgent` protocol adapter. Ordinary chat agents can use `createDurableConversationService()` with their descriptor, model/agent configuration, and storage directory; the helper owns per-thread Durable storage, input submissions, snapshots, and watches, so agents do not implement lifecycle glue. The simple-chat integration test exercises successive turns on one HTTP thread and verifies that the second model request receives the earlier transcript. Custom workflows can also live under a Durable root conversation as tasks, but their status, progress, outputs, and pending-input conventions must be standardized before their per-agent mapping can disappear. Deep Research is already implemented with Durable tasks, but its `RunDoc`/clarification lifecycle is still exposed through a custom service adapter. The shared protocol adapter maps starts, input responses, state reads, progress, and results to protocol commands and events. Services may emit optional custom events for domain-specific details. They need not use LangGraph or inherit the research service API. The protocol bridge and typed client are the only modules that import the draft `@langchain/protocol` types (pinned in `package.json`).

## Persistence and privacy

Each Deep Research run gets an isolated SQLite database under `.deep-research/runs/<run-id>.sqlite`. Simple Chat stores one SQLite database per hosted thread under `.agent-server/conversations/simple-chat/`; it contains that thread's Durable transcript. These directories are git-ignored; keep them local and protect them as user data. SQLite-backed Durable state survives ordinary process exits/crashes; a request interrupted inside an LLM call may be retried on resume.

## Configuration

Configuration is environment-based to match the existing research agent. The CLI loads `.env` automatically for its server URL and bearer token; the server loads the environment file named in its manifest. In-process library users should populate `process.env` before creating the service.

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

# ADR 0001: Durable deep-research CLI

- **Status:** Accepted and implemented in this workspace
- **Date:** 2026-03-19

## Context

The existing LangGraph deep-research agent has a clarification step, a research brief, a supervising loop that delegates bounded concurrent research units, researcher tool loops, compression, and final report generation. The replacement should use pi-durable while keeping the first interface CLI-only.

## Decisions

### Invocation and run identity

- A normal invocation starts exactly one logical research run:
  ```sh
  deep-research "Research topic..."
  ```
- A run may ask clarification questions interactively in the terminal. The user’s answer resumes that logical run.
- The CLI prints a stable run ID before doing work. Resume and discovery commands are:
  ```sh
  deep-research resume <run-id>
  deep-research list
  ```
- Each run has its own SQLite database under the current project, e.g. `.deep-research/runs/<run-id>.sqlite`. This isolates Durable’s session-level scheduler: resuming one run will not start other runs.
- Configuration comes from the existing environment-based model, search, and research-limit settings; v1 does not add corresponding CLI flags. `.env` is loaded for local CLI use.
- One invocation exits after printing its final report.

### Durability and terminal behavior

- Ctrl-C stops the CLI process but leaves the saved run resumable. It does not mean “abort this research permanently.”
- Progress/status is written to stderr; the final report is written to stdout.
- A clarification pause is represented as saved application state (question, workflow checkpoint, and accumulated findings), not as an in-memory prompt or `watchTaskGraph` state. On resume, the CLI re-presents the pending question. The answer starts a continuation task under the same public run ID.

### Workflow architecture

- A custom Durable coordinator task owns application-level routing: clarification, brief generation, supervisor decisions, bounded delegation, result aggregation, repeated supervision, and final reporting.
- Research assignments run as child Durable conversations, using Durable’s built-in generation and tool loop rather than a custom researcher task/tool-call loop. Researchers receive Tavily, think, research-complete, and optional read-only project-skill tools.
- The coordinator creates no more than the configured number of concurrent researcher conversations, waits for all results, retains successful results when a sibling fails, and preserves the supervisor-round limit.
- Researcher conversations use `maxTurns` for the researcher iteration cap. Because `maxTurns` limits tool rounds, not Tavily calls, a persisted per-researcher search counter in the Tavily tool enforces the search cap. `research_complete` provides an early-stop path. Turn-limited researchers with partial findings/sources still contribute to compression.
- Compression and final report generation remain explicit workflow stages. Research failures and evidence gaps are retained for the final report.
- `harness.watchTaskGraph()` is used for live task progress, not as the workflow router or the source of clarification state.

## Consequences

- Durable’s built-in conversation machinery removes the need to hand-code the researcher’s model/tool-call loop.
- The coordinator remains explicit application code so the research graph’s branching, limits, parallelism, and failure aggregation are deterministic and checkpointed.
- A public run ID is distinct from an individual Durable task ID because clarification/resume may create continuation tasks.
- Exact `maxTurns` behavior must be handled deliberately: Durable still runs tools from the round that reaches the limit, then ends that conversation run with `turn_limit`; the coordinator should collect and compress its available findings rather than treating this budget stop as a provider failure.
- The `.deep-research` directory should be excluded from version control because it contains prompts, findings, sources, and run state.

## Not in scope for v1

- React/UI contracts, a LangGraph-style visual graph, or remote graph server.
- A general multi-turn chat session after the final report.
- A custom Durable task for every researcher.

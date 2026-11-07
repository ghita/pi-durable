# Deep-research CLI glossary

- **Research run:** The user-visible, single-request research job started by `deep-research "..."`. It has a stable public run ID and may span multiple internal Durable tasks when it pauses for clarification.
- **Run ID:** The stable CLI-facing identifier used by `resume` and `list`. It identifies the per-run SQLite file; it is not necessarily a Durable task ID.
- **Run database:** The per-run SQLite file stored under `.deep-research/runs/`. It holds Durable task checkpoints and the application state needed to resume that logical run.
- **Coordinator task:** The custom Durable task that routes the research stages, manages supervisor rounds and concurrent assignments, gathers researcher results, and decides when to produce the final report.
- **Researcher conversation:** A child Durable conversation assigned one research topic. Its ordinary Durable generation/tool loop handles model turns and registered tools.
- **Clarification checkpoint:** Persisted application state containing the pending question and workflow progress. The CLI asks the question; after an answer it starts a continuation under the same run ID.
- **Continuation task:** A new Durable task segment that resumes a logical run from its saved checkpoint and clarification answer.
- **Task graph:** Durable’s live task/ownership view, observed with `harness.watchTaskGraph()`. It is for progress/inspection; it does not define the workflow’s routing logic.
- **Research budget:** The limits for concurrent researchers, supervisor rounds, researcher tool turns, and Tavily searches. Turn and search budgets are distinct; searches need their own persisted counter.

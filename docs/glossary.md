# Deep-research glossary

- **Research run:** The caller-visible, single-request research job. It has a stable Run ID and may span multiple internal Durable tasks when it pauses for clarification. Each research case gets its own server thread; clarification and continuation stay within that thread, while a separate case gets a new thread.
- **ResearchRunAgent:** The transport-independent service through which callers select a research agent and manage its runs.
- **Run ID:** The stable caller-facing identifier for a research run, independent of transport. It is not necessarily a Durable task ID.
- **Run database:** The per-run SQLite file stored under `.deep-research/runs/`. It holds Durable task checkpoints and the application state needed to resume that logical run.
- **Coordinator task:** The custom Durable task that routes the research stages, manages supervisor rounds and concurrent assignments, gathers researcher results, and decides when to produce the final report.
- **Researcher conversation:** A child Durable conversation assigned one research topic. Its ordinary Durable generation/tool loop handles model turns and registered tools.
- **Clarification checkpoint:** Persisted application state containing a pending question and workflow progress. The caller supplies an answer through its chosen interface; the run continues under the same Run ID.
- **Continuation task:** A new Durable task segment that resumes a logical run from its saved checkpoint and clarification answer.
- **Task graph:** Durable’s live task/ownership view, observed with `harness.watchTaskGraph()`. It is for progress/inspection; it does not define the workflow’s routing logic.
- **Research budget:** The limits for concurrent researchers, supervisor rounds, researcher tool turns, and Tavily searches. Turn and search budgets are distinct; searches need their own persisted counter.
- **Server-registered agent:** A named, runnable agent implementation made available by a server's configuration. It is distinct from a run (one execution of that agent) and from the Durable tasks or conversations used internally to implement it.
- **Agent catalog:** The configured set of server-registered agents discoverable by connecting to one server. Catalog discovery is scoped to that server; there is no central hub.
- **Agent wire protocol:** The commands and events clients and servers use to address an agent, submit or continue work, and exchange progress, input requests, and results. It is separate from catalog configuration and from storage/recovery policy.
- **Thread:** A stable, server-persisted conversation context that groups related runs and their state. A thread is permanently bound to one server-registered agent when created; different threads have independent state, and multiple clients may access the same thread.

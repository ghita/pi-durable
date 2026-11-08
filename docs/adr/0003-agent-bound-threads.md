# Explicit, agent-bound threads

**Status:** accepted

Create threads explicitly with a server-registered agent ID, and bind each thread permanently to that agent. Thread creation accepts an optional client-supplied ID and generates one when omitted. Duplicate IDs raise by default; an explicit `do_nothing` returns the existing thread when it is bound to the requested agent. If it is bound to a different agent, creation returns `409 Conflict`; the binding cannot change. This keeps persisted state within the agent that understands it; a different agent or a new research case gets a new thread. Research clarification and continuation remain within the original research thread. We chose explicit creation over lazy first-run creation so the server establishes and validates the agent/thread association before accepting work.

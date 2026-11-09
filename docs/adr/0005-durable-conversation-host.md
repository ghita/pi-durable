# Durable conversations as the default agent host

**Status:** Accepted

Ordinary agents use a reusable Durable conversation service: one hosted thread maps to one persisted Pi Durable root conversation, and each user turn is a Durable input submission. Agents provide model and conversation configuration instead of hand-written lifecycle integration. Custom workflows remain Durable tasks and can share the same hosting path once their run state and same-run input pauses use a common contract; Deep Research keeps its custom service mapping until that migration is made. This keeps workflow-specific interpretation out of the protocol adapter without pretending arbitrary task state is already a standard chat lifecycle.

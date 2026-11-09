# Agent Hosting

This context covers how application-owned agent workflows are exposed through the server to clients, while keeping workflow behavior independent of transport.

## Language

**Agent service**:
An application-owned interface for starting and observing agent work, and for continuing it when the workflow requires more input.
_Avoid_: Hosted agent

**Hosted agent**:
An agent registered with the server and exposed to clients through its thread and command protocol.
_Avoid_: Agent service

**Host adapter**:
The boundary that translates between an agent service and the server's hosted-agent contract.
_Avoid_: Agent implementation

**Durable conversation host**:
A reusable agent-service implementation that maps each hosted thread to a persistent Pi Durable root conversation and supplies the standard submission, snapshot, and watch lifecycle.
_Avoid_: Workflow-specific adapter

**Custom workflow**:
Agent behavior implemented by Durable tasks or application state rather than the built-in conversation generation loop; it must expose status, progress, output, and input pauses through the shared lifecycle contract.
_Avoid_: Ordinary chat turn

**Thread**:
A persistent interaction context bound to one hosted agent; depending on that agent's policy, it can represent one case or contain successive runs.
_Avoid_: Run

**Run**:
One unit of agent work started by a client command. On a multi-turn thread, each new user turn starts a new run; an input response continues the pending run instead.
_Avoid_: Turn, session

**Interruption**:
A point where a run pauses to request user input and waits for a response before continuing.
_Avoid_: New turn

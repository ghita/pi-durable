import type { AgentService, AgentServiceEvent, AgentRunSnapshot } from "./agent-service.ts";
import { AgentCommandError, type AgentCommandResult, type HostedAgent, type HostedAgentEvent, type PendingAgentInput } from "./types.ts";

function lifecycleEvent(snapshot: AgentRunSnapshot, agentId: string): HostedAgentEvent {
  const data = {
    event: snapshot.status === "awaiting_input" ? "interrupted" : snapshot.status,
    agent_id: agentId,
    ...(snapshot.error ? { error: snapshot.error } : {}),
  };
  return {
    channel: "lifecycle",
    method: "lifecycle",
    namespace: [],
    timestamp: snapshot.updatedAt,
    data,
    threadStatus: snapshot.status,
    runId: snapshot.runId,
    ...(snapshot.summary ? { summary: snapshot.summary } : {}),
  };
}

function progressEvent(snapshot: AgentRunSnapshot): HostedAgentEvent | undefined {
  if (!snapshot.progress) return undefined;
  return {
    channel: "custom",
    method: "custom",
    namespace: [],
    timestamp: snapshot.updatedAt,
    data: {
      name: "agent.progress",
      payload: {
        run_id: snapshot.runId,
        status: snapshot.status,
        ...snapshot.progress,
      },
    },
    runId: snapshot.runId,
    threadStatus: snapshot.status,
    ...(snapshot.summary ? { summary: snapshot.summary } : {}),
  };
}

function pendingInputKey(input: PendingAgentInput): string {
  return JSON.stringify([input.namespace, input.interruptId]);
}

function inputRequestedEvent(snapshot: AgentRunSnapshot, input: PendingAgentInput): HostedAgentEvent {
  return {
    channel: "input",
    method: "input.requested",
    namespace: [...input.namespace],
    timestamp: snapshot.updatedAt,
    data: { interrupt_id: input.interruptId, payload: input.payload },
    runId: snapshot.runId,
    threadStatus: "awaiting_input",
    ...(snapshot.summary ? { summary: snapshot.summary } : {}),
  };
}

function inputAnsweredEvents(snapshot: AgentRunSnapshot, removed: PendingAgentInput[]): HostedAgentEvent[] {
  const byNamespace = new Map<string, PendingAgentInput[]>();
  for (const input of removed) {
    const key = JSON.stringify(input.namespace);
    const group = byNamespace.get(key) ?? [];
    group.push(input);
    byNamespace.set(key, group);
  }
  return [...byNamespace.values()].map((inputs) => ({
    channel: "input",
    method: "input.answered",
    namespace: [...inputs[0]!.namespace],
    timestamp: snapshot.updatedAt,
    data: { interrupt_ids: inputs.map((input) => input.interruptId) },
    runId: snapshot.runId,
    threadStatus: snapshot.status,
  }));
}

function resultEvent(snapshot: AgentRunSnapshot): HostedAgentEvent | undefined {
  if (snapshot.status !== "completed" || snapshot.output === undefined) return undefined;
  return {
    channel: "custom",
    method: "custom",
    namespace: [],
    timestamp: snapshot.updatedAt,
    data: { name: "agent.result", payload: { run_id: snapshot.runId, output: snapshot.output } },
    runId: snapshot.runId,
    threadStatus: snapshot.status,
    ...(snapshot.summary ? { summary: snapshot.summary } : {}),
  };
}

function customEvent(snapshot: AgentRunSnapshot, event: AgentServiceEvent): HostedAgentEvent {
  return {
    channel: "custom",
    method: "custom",
    namespace: [...(event.namespace ?? [])],
    timestamp: event.timestamp ?? snapshot.updatedAt,
    data: { name: event.name, payload: event.payload },
    runId: snapshot.runId,
    threadStatus: snapshot.status,
    ...(snapshot.summary ? { summary: snapshot.summary } : {}),
  };
}

function snapshotState(snapshot: AgentRunSnapshot | undefined): Record<string, unknown> {
  if (!snapshot) return {};
  return {
    ...(snapshot.state ?? {}),
    run_id: snapshot.runId,
    status: snapshot.status,
    ...(snapshot.progress?.phase ? { phase: snapshot.progress.phase } : {}),
    ...(snapshot.progress ? { progress: snapshot.progress } : {}),
    ...(snapshot.output !== undefined ? { output: snapshot.output } : {}),
    ...(snapshot.error ? { error: snapshot.error } : {}),
  };
}

function commandResult(snapshot: AgentRunSnapshot, result: unknown): AgentCommandResult {
  return {
    result,
    runId: snapshot.runId,
    status: snapshot.status,
    ...(snapshot.summary ? { summary: snapshot.summary } : {}),
  };
}

function snapshotSignature(snapshot: AgentRunSnapshot): string {
  return JSON.stringify(snapshot);
}

/** Wrap an application-owned lifecycle service in the server's protocol-facing HostedAgent contract. */
export function createHostedAgentAdapter(service: AgentService): HostedAgent {
  const lastSnapshots = new Map<string, AgentRunSnapshot>();
  return {
    descriptor: service.descriptor,
    async initialize() {
      await service.initialize?.();
    },
    async createThread(thread) {
      return service.createThread(thread);
    },
    async handleCommand(threadId, command): Promise<AgentCommandResult> {
      if (command.type === "run.start") {
        if (command.assistantId !== service.descriptor.id) {
          throw new AgentCommandError("assistant_id does not match the thread's bound agent.", 409);
        }
        const snapshot = await service.startRun(threadId, command.input, command.commandId, {
          ...(command.config ? { config: command.config } : {}),
          ...(command.metadata ? { metadata: command.metadata } : {}),
          ...(command.langsmithTracer ? { langsmithTracer: command.langsmithTracer } : {}),
        });
        return commandResult(snapshot, { run_id: snapshot.runId });
      }
      if (command.type === "input.respond") {
        const snapshot = await service.respond(threadId, {
          namespace: command.namespace,
          interruptId: command.interruptId,
          response: command.response,
          commandId: command.commandId,
        }, {
          ...(command.update ? { update: command.update } : {}),
          ...(command.goto !== undefined ? { goto: command.goto } : {}),
          ...(command.config ? { config: command.config } : {}),
          ...(command.metadata ? { metadata: command.metadata } : {}),
        });
        return commandResult(snapshot, {});
      }

      const snapshot = await service.getSnapshot(threadId, command.namespace);
      const values = snapshotState(snapshot);
      const selected = command.keys
        ? Object.fromEntries(command.keys.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]))
        : values;
      return {
        result: { values: selected },
        ...(snapshot ? {
          runId: snapshot.runId,
          status: snapshot.status,
          ...(snapshot.summary ? { summary: snapshot.summary } : {}),
        } : {}),
      };
    },
    async *subscribe(threadId): AsyncIterable<HostedAgentEvent> {
      const previousSnapshot = lastSnapshots.get(threadId);
      let previousSignature = previousSnapshot ? snapshotSignature(previousSnapshot) : undefined;
      let previousPending = new Map((previousSnapshot?.pendingInputs ?? []).map((input) => [pendingInputKey(input), input]));
      let previousRunId = previousSnapshot?.runId;
      let previousStatus = previousSnapshot?.status;
      let previousProgress = JSON.stringify(previousSnapshot?.progress);
      let previousOutput = JSON.stringify(previousSnapshot?.output);
      for await (const update of service.watch(threadId)) {
        const snapshot = update.snapshot;
        const signature = snapshotSignature(snapshot);
        const changed = signature !== previousSignature;
        if (changed) {
          if (previousSignature === undefined || snapshot.runId !== previousRunId) {
            yield lifecycleEvent(snapshot, service.descriptor.id);
          } else if (snapshot.status !== previousStatus) {
            yield lifecycleEvent(snapshot, service.descriptor.id);
          }

          const currentPending = new Map((snapshot.pendingInputs ?? []).map((input) => [pendingInputKey(input), input]));
          const removed = [...previousPending.entries()]
            .filter(([key]) => !currentPending.has(key))
            .map(([, input]) => input);
          for (const event of inputAnsweredEvents(snapshot, removed)) yield event;
          for (const [key, input] of currentPending) {
            if (!previousPending.has(key) || snapshot.runId !== previousRunId) yield inputRequestedEvent(snapshot, input);
          }

          if (snapshot.progress && JSON.stringify(snapshot.progress) !== previousProgress) {
            const event = progressEvent(snapshot);
            if (event) yield event;
          }
          const outputSignature = JSON.stringify(snapshot.output);
          if (snapshot.status === "completed" && snapshot.output !== undefined
            && (previousStatus !== "completed" || snapshot.runId !== previousRunId || outputSignature !== previousOutput)) {
            const event = resultEvent(snapshot);
            if (event) yield event;
          }

          previousSignature = signature;
          previousPending = currentPending;
          previousRunId = snapshot.runId;
          previousStatus = snapshot.status;
          previousProgress = JSON.stringify(snapshot.progress);
          previousOutput = outputSignature;
          lastSnapshots.set(threadId, snapshot);
        }
        for (const event of update.events ?? []) yield customEvent(snapshot, event);
      }
    },
    async close() {
      await service.close();
    },
  };
}

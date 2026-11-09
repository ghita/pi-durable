import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createResearchRunAgent, type ResearchRunAgent, type ResearchRunSnapshot } from "../src/research-run-agent.ts";
import { loadAgentCatalog } from "../src/agent-server/catalog.ts";
import { AgentServerClient } from "../src/agent-server/client.ts";
import { createResearchHostedAgent, researchAgentDescriptor } from "../src/agent-server/research-adapter.ts";
import { createHostedAgentAdapter } from "../src/agent-server/host-adapter.ts";
import { createSimpleChatAgentService, simpleChatDescriptor } from "../src/agent-server/simple-chat.ts";
import { createAgentServer } from "../src/agent-server/server.ts";
import { parseProtocolCommand } from "../src/agent-server/protocol.ts";
import type { AgentService, AgentRunSnapshot } from "../src/agent-server/agent-service.ts";
import type { AgentCommand, AgentDescriptor, HostedAgent, HostedAgentEvent, HostedThread, ThreadStatus } from "../src/agent-server/types.ts";

const TOKEN = "test-token-with-enough-entropy";

class FakeHostedAgent implements HostedAgent {
  readonly descriptor: AgentDescriptor = {
    id: "fake",
    name: "Fake agent",
    description: "Test implementation",
    threadPolicy: "multi-turn",
    capabilities: ["streaming", "interrupts"],
  };
  readonly created: HostedThread[] = [];
  readonly commands: AgentCommand[] = [];
  initialized = false;
  closed = false;

  async initialize(): Promise<void> { this.initialized = true; }
  async createThread(thread: HostedThread): Promise<unknown> {
    this.created.push(structuredClone(thread));
    return thread.adapterRef ?? { opaque: `adapter:${thread.threadId}` };
  }
  async handleCommand(threadId: string, command: AgentCommand) {
    this.commands.push(command);
    if (command.type === "run.start") {
      return { result: { run_id: threadId }, runId: threadId, status: "running" as const, summary: { title: "test" } };
    }
    if (command.type === "input.respond") {
      return { result: {}, runId: threadId, status: "running" as const };
    }
    return { result: { values: { thread_id: threadId } }, runId: threadId, status: "running" as const };
  }
  async *subscribe(threadId: string): AsyncIterable<HostedAgentEvent> {
    yield {
      channel: "lifecycle",
      method: "lifecycle",
      namespace: [],
      timestamp: Date.now(),
      data: { event: "completed", graph_name: "fake" },
      threadStatus: "completed",
      runId: threadId,
    };
  }
  async close(): Promise<void> { this.closed = true; }
}

class FloodHostedAgent extends FakeHostedAgent {
  async *subscribe(): AsyncIterable<HostedAgentEvent> {
    const payload = "x".repeat(32_768);
    for (let index = 0; index < 500; index += 1) {
      yield { channel: "custom", method: "custom", namespace: [], timestamp: index, data: { name: "flood", payload } };
    }
  }
}

class GatedHostedAgent extends FakeHostedAgent {
  #gate: Promise<void>;
  #releaseGate!: () => void;

  constructor() {
    super();
    this.#gate = new Promise<void>((resolveGate) => { this.#releaseGate = resolveGate; });
  }

  release(): void { this.#releaseGate(); }

  async *subscribe(threadId: string): AsyncIterable<HostedAgentEvent> {
    yield { channel: "lifecycle", method: "lifecycle", namespace: [], timestamp: Date.now(), data: { event: "running" }, threadStatus: "running", runId: threadId };
    await this.#gate;
    yield { channel: "lifecycle", method: "lifecycle", namespace: [], timestamp: Date.now(), data: { event: "completed" }, threadStatus: "completed", runId: threadId };
  }
}

class MultiTurnAgentService implements AgentService {
  readonly descriptor: AgentDescriptor = {
    id: "multi-turn",
    name: "Multi-turn test agent",
    description: "Exercises the shared service adapter.",
    threadPolicy: "multi-turn",
    capabilities: ["interrupts", "streaming"],
  };
  readonly starts: Array<{ threadId: string; input: unknown; commandId: string }> = [];
  readonly responses: Array<{ threadId: string; interruptId: string; response: unknown; commandId: string }> = [];
  readonly snapshots = new Map<string, AgentRunSnapshot>();
  #turns = new Map<string, number>();

  async createThread(_thread: HostedThread): Promise<void> {}

  async startRun(threadId: string, input: unknown, commandId: string): Promise<AgentRunSnapshot> {
    this.starts.push({ threadId, input, commandId });
    const turn = (this.#turns.get(threadId) ?? 0) + 1;
    this.#turns.set(threadId, turn);
    const snapshot: AgentRunSnapshot = turn === 1
      ? {
          runId: `run-${turn}`,
          status: "awaiting_input",
          updatedAt: turn,
          progress: { phase: "clarifying", message: "Need one detail" },
          pendingInputs: [{ namespace: [], interruptId: `interrupt-${turn}`, payload: { question: "Which region?" } }],
        }
      : turn === 2
        ? { runId: `run-${turn}`, status: "failed", updatedAt: turn, error: "Expected test failure" }
        : { runId: `run-${turn}`, status: "completed", updatedAt: turn, output: input };
    this.snapshots.set(threadId, snapshot);
    return snapshot;
  }

  async respond(threadId: string, input: { interruptId: string; response: unknown; commandId: string }): Promise<AgentRunSnapshot> {
    this.responses.push({ threadId, ...input });
    const current = this.snapshots.get(threadId)!;
    const snapshot: AgentRunSnapshot = {
      ...current,
      status: "completed",
      updatedAt: current.updatedAt + 1,
      pendingInputs: [],
      output: `Answer: ${String(input.response)}`,
    };
    this.snapshots.set(threadId, snapshot);
    return snapshot;
  }

  async getSnapshot(threadId: string): Promise<AgentRunSnapshot | undefined> { return this.snapshots.get(threadId); }

  async *watch(threadId: string) {
    const snapshot = this.snapshots.get(threadId);
    if (snapshot) yield { snapshot, events: [{ name: "test.snapshot", payload: { run_id: snapshot.runId } }] };
  }

  async close(): Promise<void> {}
}

async function waitForStatus(client: AgentServerClient, threadId: string, status: ThreadStatus): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((await client.getThread(threadId)).status === status) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.equal((await client.getThread(threadId)).status, status);
}

test("HTTP client gives actionable guidance when the server cannot be reached", async () => {
  const client = new AgentServerClient({
    baseUrl: "http://127.0.0.1:3000",
    token: TOKEN,
    fetch: async () => { throw new TypeError("fetch failed"); },
  });
  await assert.rejects(client.listAgents(), /Cannot reach agent server at http:\/\/127\.0\.0\.1:3000\. Run "npm run server"/);
});

test("protocol bridge preserves standard run and input response options", () => {
  const run = parseProtocolCommand({
    id: 8,
    method: "run.start",
    params: {
      assistant_id: "fake",
      input: { prompt: "hello" },
      config: { configurable: { temperature: 0.2 } },
      metadata: { trace: "case" },
      langsmith_tracer: { project_name: "project" },
    },
  });
  assert.deepEqual(run.command, {
    type: "run.start",
    commandId: "8",
    assistantId: "fake",
    input: { prompt: "hello" },
    config: { configurable: { temperature: 0.2 } },
    metadata: { trace: "case" },
    langsmithTracer: { project_name: "project" },
  });

  const answer = parseProtocolCommand({
    id: 9,
    method: "input.respond",
    params: {
      namespace: ["approval"],
      interrupt_id: "interrupt-1",
      response: "yes",
      update: { approved: true },
      goto: "continue",
      config: { tags: ["test"] },
      metadata: { source: "client" },
    },
  });
  assert.deepEqual(answer.command, {
    type: "input.respond",
    commandId: "9",
    namespace: ["approval"],
    interruptId: "interrupt-1",
    response: "yes",
    update: { approved: true },
    goto: "continue",
    config: { tags: ["test"] },
    metadata: { source: "client" },
  });
});

test("catalog loader imports trusted local factories and enforces manifest descriptor IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-catalog-"));
  try {
    const fixture = resolve("test/fixtures/agent-catalog-fixture.ts");
    const manifest = join(directory, "agent-server.json");
    await writeFile(manifest, JSON.stringify({ agents: { fixture: `${fixture}:createFixtureAgent` } }));
    const catalog = await loadAgentCatalog(manifest, {});
    assert.deepEqual([...catalog.agents.keys()], ["fixture"]);
    await catalog.close();

    await writeFile(manifest, JSON.stringify({ agents: { other: `${fixture}:createFixtureAgent` } }));
    await assert.rejects(() => loadAgentCatalog(manifest, {}), /does not match manifest ID/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP host discovers agents, binds threads, caches command IDs, streams protocol events, and recovers state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-server-http-"));
  const statePath = join(directory, "server-state.json");
  let firstAgent = new FakeHostedAgent();
  let server = createAgentServer({ agents: [firstAgent], token: TOKEN, host: "127.0.0.1", port: 0, statePath });
  let address = await server.listen();
  let client = new AgentServerClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: TOKEN });
  try {
    assert.equal(firstAgent.initialized, true);
    assert.equal((await client.listAgents())[0]?.id, "fake");
    const unauthorized = await fetch(`http://127.0.0.1:${address.port}/v1/agents`);
    assert.equal(unauthorized.status, 401);

    const thread = await client.createThread({ agentId: "fake", threadId: "stable-thread", metadata: { origin: "test" } });
    assert.equal(thread.status, "idle");
    assert.deepEqual(thread.metadata, { origin: "test" });
    assert.equal((await client.createThread({ agentId: "fake", threadId: "stable-thread", ifExists: "do_nothing" })).threadId, thread.threadId);
    await assert.rejects(() => client.createThread({ agentId: "fake", threadId: "stable-thread" }), (error: unknown) => {
      assert.equal((error as { status: number }).status, 409);
      return true;
    });

    await client.startRun(thread.threadId, "not-the-bound-agent", { request: "No" }, 20).then(
      () => assert.fail("assistant mismatch must conflict"),
      (error: unknown) => assert.equal((error as { status: number }).status, 409),
    );
    const startCommand = {
      method: "run.start" as const,
      params: {
        assistant_id: "fake",
        input: { request: "Hello" },
        config: { configurable: { temperature: 0.1 } },
        metadata: { origin: "test" },
        langsmith_tracer: { project_name: "contract" },
      },
      id: 1,
    };
    const accepted = await client.command(thread.threadId, startCommand);
    assert.deepEqual(accepted.result, { run_id: "stable-thread" });
    const forwarded = firstAgent.commands.find((command) => command.type === "run.start");
    assert.deepEqual(forwarded, {
      type: "run.start", commandId: "1", assistantId: "fake", input: { request: "Hello" },
      config: { configurable: { temperature: 0.1 } }, metadata: { origin: "test" }, langsmithTracer: { project_name: "contract" },
    });
    await waitForStatus(client, thread.threadId, "completed");

    const replay = await client.command(thread.threadId, startCommand);
    assert.deepEqual(replay, accepted);
    assert.equal(firstAgent.commands.filter((command) => command.type === "run.start").length, 1);
    await client.startRun(thread.threadId, "fake", { request: "Different" }, 1).then(
      () => assert.fail("reusing an ID with a different body must conflict"),
      (error: unknown) => assert.equal((error as { status: number }).status, 409),
    );

    const events = [];
    for await (const event of client.stream(thread.threadId, { channels: ["lifecycle"] })) {
      events.push(event);
      if (events.length === 1) break;
    }
    assert.equal(events[0]?.type, "event");
    assert.equal(events[0]?.method, "lifecycle");
    assert.ok(events[0]?.seq);

    const nestedThread = await client.createThread({ agentId: "fake", threadId: "nested-input-thread" });
    await client.respond(nestedThread.threadId, "approval-1", "approve", 30, ["approval"]);
    assert.deepEqual(firstAgent.commands.at(-1), {
      type: "input.respond", commandId: "30", namespace: ["approval"], interruptId: "approval-1", response: "approve",
    });

    const page = await client.listThreads({ limit: 10 });
    assert.ok(page.threads.some((listed) => listed.threadId === "stable-thread"));

    const secondClient = new AgentServerClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: TOKEN });
    const multiTurn = await client.createThread({ agentId: "fake", threadId: "multi-client-thread" });
    const firstClientCommandId = client.allocateCommandId();
    const secondClientCommandId = secondClient.allocateCommandId();
    assert.notEqual(firstClientCommandId, secondClientCommandId);
    await client.startRun(multiTurn.threadId, "fake", { request: "first client" }, firstClientCommandId);
    await waitForStatus(client, multiTurn.threadId, "completed");
    await secondClient.startRun(multiTurn.threadId, "fake", { request: "second client" }, secondClientCommandId);
    await waitForStatus(client, multiTurn.threadId, "completed");

    const anotherClient = new AgentServerClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: TOKEN });
    const autoIdThread = await client.createThread({ agentId: "fake", threadId: "auto-id-thread" });
    await client.startRun(autoIdThread.threadId, "fake", { request: "first generated ID" });
    await waitForStatus(client, autoIdThread.threadId, "completed");
    await anotherClient.startRun(autoIdThread.threadId, "fake", { request: "second generated ID" });
    await waitForStatus(client, autoIdThread.threadId, "completed");

    await server.close();
    firstAgent = new FakeHostedAgent();
    server = createAgentServer({ agents: [firstAgent], token: TOKEN, host: "127.0.0.1", port: 0, statePath });
    address = await server.listen();
    client = new AgentServerClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: TOKEN });
    assert.equal(firstAgent.created[0]?.adapterRef && (firstAgent.created[0]!.adapterRef as { opaque: string }).opaque, "adapter:stable-thread");
    assert.equal((await client.getThread("stable-thread")).status, "completed");
    const recoveredReplay = await client.command("stable-thread", startCommand);
    assert.deepEqual(recoveredReplay, accepted);
    assert.equal(firstAgent.commands.length, 0);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("shared service adapter supports interrupted and successive runs on a multi-turn thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-server-service-adapter-"));
  const service = new MultiTurnAgentService();
  const server = createAgentServer({ agents: [createHostedAgentAdapter(service)], token: TOKEN, host: "127.0.0.1", port: 0, statePath: join(directory, "state.json") });
  try {
    const address = await server.listen();
    const client = new AgentServerClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: TOKEN });
    const thread = await client.createThread({ agentId: service.descriptor.id, threadId: "multi-turn-service" });

    const firstStart = { method: "run.start" as const, params: { assistant_id: service.descriptor.id, input: { message: "Hello" } }, id: 101 };
    const paused = await client.command(thread.threadId, firstStart);
    assert.equal((await client.getThread(thread.threadId)).status, "awaiting_input");
    assert.equal((paused.result as { run_id: string }).run_id, "run-1");
    assert.deepEqual(service.starts[0], { threadId: thread.threadId, input: { message: "Hello" }, commandId: "101" });
    await client.startRun(thread.threadId, service.descriptor.id, { message: "Do not start over the interruption" }, 102).then(
      () => assert.fail("a new run must not replace a pending input"),
      (error: unknown) => assert.equal((error as { status: number }).status, 409),
    );
    assert.equal(service.starts.length, 1);

    await client.respond(thread.threadId, "interrupt-1", "Europe", 103);
    await waitForStatus(client, thread.threadId, "completed");
    assert.deepEqual(service.responses, [{ threadId: thread.threadId, namespace: [], interruptId: "interrupt-1", response: "Europe", commandId: "103" }]);
    const state = await client.getState(thread.threadId);
    assert.equal((state.result as { values: Record<string, unknown> }).values.output, "Answer: Europe");

    const events = [];
    for await (const event of client.stream(thread.threadId, { channels: ["lifecycle", "input", "custom"] })) {
      events.push(event);
      if (event.method === "custom" && (event.params as { data: { name?: string } }).data.name === "agent.result") break;
    }
    const eventNames = events.map((event) => {
      const data = (event.params as { data?: { name?: string; event?: string } }).data;
      return data?.name ?? data?.event ?? event.method;
    });
    assert.ok(eventNames.includes("interrupted"));
    assert.ok(eventNames.includes("input.requested"));
    assert.ok(eventNames.includes("agent.progress"));
    assert.ok(eventNames.includes("test.snapshot"));
    assert.ok(eventNames.includes("agent.result"));

    const failedTurn = await client.startRun(thread.threadId, service.descriptor.id, { message: "Turn that fails" }, 104);
    await waitForStatus(client, thread.threadId, "failed");
    assert.equal((failedTurn.result as { run_id: string }).run_id, "run-2");
    assert.equal(service.starts.length, 2);
    const replay = await client.startRun(thread.threadId, service.descriptor.id, { message: "Turn that fails" }, 104);
    assert.deepEqual(replay, failedTurn);
    assert.equal(service.starts.length, 2, "host command replay must not start another service run");

    const nextTurn = await client.startRun(thread.threadId, service.descriptor.id, { message: "Continue after failure" }, 105);
    await waitForStatus(client, thread.threadId, "completed");
    assert.equal((nextTurn.result as { run_id: string }).run_id, "run-3");
    assert.equal(service.starts.length, 3);
    assert.equal(service.starts[2]?.commandId, "105");
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("slow SSE consumers are bounded and disconnected rather than accumulating unbounded events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-server-slow-stream-"));
  const server = createAgentServer({ agents: [new FloodHostedAgent()], token: TOKEN, host: "127.0.0.1", port: 0, statePath: join(directory, "state.json") });
  let iterator: AsyncIterator<import("@langchain/protocol").Event> | undefined;
  try {
    const address = await server.listen();
    const client = new AgentServerClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: TOKEN });
    const thread = await client.createThread({ agentId: "fake", threadId: "slow-consumer" });
    iterator = client.stream(thread.threadId, { channels: ["custom"] })[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.done, false);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    let received = 1;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const next = await Promise.race([
        iterator.next(),
        new Promise<undefined>((resolveTimeout) => setTimeout(() => resolveTimeout(undefined), 1_000)),
      ]);
      if (next === undefined) break;
      if (next.done) break;
      received += 1;
    }
    assert.ok(received < 500, `expected bounded SSE delivery, received ${received} events`);
  } finally {
    await iterator?.return?.();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retry-safe capacity rejections are not cached under the command ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-server-capacity-"));
  const agent = new GatedHostedAgent();
  const server = createAgentServer({ agents: [agent], token: TOKEN, host: "127.0.0.1", port: 0, statePath: join(directory, "state.json"), maxConcurrentThreads: 1 });
  try {
    const address = await server.listen();
    const client = new AgentServerClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: TOKEN });
    const first = await client.createThread({ agentId: "fake", threadId: "capacity-one" });
    const second = await client.createThread({ agentId: "fake", threadId: "capacity-two" });
    await client.startRun(first.threadId, "fake", { request: "first" }, 1);
    await client.startRun(second.threadId, "fake", { request: "second" }, 2).then(
      () => assert.fail("the active-thread limit must reject the second run"),
      (error: unknown) => {
        assert.equal((error as { status: number }).status, 429);
        assert.equal(((error as { body: { meta: { retry_safe: boolean } } }).body).meta.retry_safe, true);
      },
    );
    agent.release();
    await waitForStatus(client, first.threadId, "completed");
    const retried = await client.startRun(second.threadId, "fake", { request: "second" }, 2);
    assert.deepEqual(retried.result, { run_id: second.threadId });
    await waitForStatus(client, second.threadId, "completed");
    assert.equal(agent.commands.filter((command) => command.type === "run.start").length, 2);
  } finally {
    agent.release();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("one process exclusively owns a server data directory and releases only its own lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-server-lock-"));
  const statePath = join(directory, "state.json");
  const first = createAgentServer({ agents: [new FakeHostedAgent()], token: TOKEN, host: "127.0.0.1", port: 0, statePath });
  const competingAgent = new FakeHostedAgent();
  const competing = createAgentServer({ agents: [competingAgent], token: TOKEN, host: "127.0.0.1", port: 0, statePath });
  try {
    await first.listen();
    await assert.rejects(() => competing.listen(), /Another server process/);
    await competing.close();
    assert.equal(Number((await readFile(`${statePath}.lock`, "utf8")).trim()), process.pid);
  } finally {
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup reconciles a durably accepted run even when the host thread record still says idle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-server-reconcile-"));
  const statePath = join(directory, "state.json");
  const createdAt = Date.now();
  await writeFile(statePath, JSON.stringify({
    version: 1,
    threads: [{ threadId: "recovered-thread", agentId: "fake", createdAt, updatedAt: createdAt, status: "idle", adapterRef: { opaque: "adapter:recovered-thread" } }],
    commands: {},
    eventSeqs: {},
  }));
  const agent = new FakeHostedAgent();
  const server = createAgentServer({ agents: [agent], token: TOKEN, host: "127.0.0.1", port: 0, statePath });
  try {
    const address = await server.listen();
    const client = new AgentServerClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: TOKEN });
    const recovered = await client.getThread("recovered-thread");
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.currentRun?.runId, "recovered-thread");
    assert.ok((recovered.eventCursor ?? 0) > 0);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("ResearchRunAgent adapter maps generic run, clarification, state, and protocol events", async () => {
  let runId = "a8098b35-9f2f-4b2c-a633-7c57f2e3bc4e";
  let snapshot: ResearchRunSnapshot | undefined;
  const fakeResearchAgent: ResearchRunAgent = {
    async listAgents() { return [{ id: researchAgentDescriptor.id, name: researchAgentDescriptor.name, description: researchAgentDescriptor.description }]; },
    async start(input) {
      snapshot = {
        runId: input.runId ?? runId,
        agentId: input.agentId,
        request: input.request,
        status: "awaiting_clarification",
        phase: "clarifying",
        pendingQuestion: "Which region?",
        createdAt: 10,
        updatedAt: 11,
      };
      return snapshot;
    },
    async get() { return snapshot; },
    async listRuns() { return snapshot ? [snapshot] : []; },
    async resume() { assert.ok(snapshot); return snapshot; },
    async answerClarification(id, answer) {
      assert.equal(id, runId);
      assert.equal(answer, "Europe");
      snapshot = { ...snapshot!, status: "completed", phase: "completed", report: "Europe report", updatedAt: 12 };
      delete snapshot.pendingQuestion;
      return snapshot;
    },
    async *watch() { if (snapshot) yield snapshot; },
    async close() {},
  };
  const adapter = createResearchHostedAgent({ agent: fakeResearchAgent });
  await adapter.initialize();
  const adapterRef = await adapter.createThread({ threadId: "case-1", agentId: researchAgentDescriptor.id }) as { runId: string };
  runId = adapterRef.runId;

  const started = await adapter.handleCommand("case-1", {
    type: "run.start", commandId: "1", assistantId: researchAgentDescriptor.id, input: { request: "Research recycling" },
  });
  assert.equal(started.status, "awaiting_input");
  assert.equal(started.runId, runId);

  const pendingEvents = [];
  for await (const event of adapter.subscribe("case-1", { channels: ["input"] })) pendingEvents.push(event);
  const inputEvent = pendingEvents.find((event) => event.method === "input.requested");
  assert.ok(inputEvent);
  const interruptId = (inputEvent.data as { interrupt_id: string }).interrupt_id;
  const answered = await adapter.handleCommand("case-1", {
    type: "input.respond", commandId: "2", namespace: [], interruptId, response: { answer: "Europe" },
  });
  assert.equal(answered.status, "completed");
  assert.deepEqual(answered.result, {});

  const state = await adapter.handleCommand("case-1", { type: "state.get", commandId: "3", namespace: [] });
  assert.equal((state.result as { values: Record<string, unknown> }).values.status, "completed");
  const completedEvents = [];
  for await (const event of adapter.subscribe("case-1", { channels: ["custom"] })) completedEvents.push(event);
  assert.ok(completedEvents.some((event) => (event.data as { name?: string }).name === "agent.result"));
  await adapter.close();
});

test("simple chat uses a Durable conversation for successive turns on one HTTP thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "simple-chat-server-"));
  const faux = fauxProvider();
  let secondTurnSawFirstMessage = false;
  faux.setResponses([
    fauxAssistantMessage([fauxText("Hello from turn one.")]),
    ({ messages }) => {
      secondTurnSawFirstMessage = JSON.stringify(messages).includes("What is Pi Durable?");
      return fauxAssistantMessage([fauxText("Pi Durable is the conversation runtime.")]);
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const serviceOptions = {
    dataDirectory: join(directory, "conversations"),
    models,
    model: { provider: "faux", modelId: "faux-1" },
  };
  const statePath = join(directory, "server-state.json");
  const createServer = () => createAgentServer({
    agents: [createHostedAgentAdapter(createSimpleChatAgentService(serviceOptions))],
    token: TOKEN,
    host: "127.0.0.1",
    port: 0,
    statePath,
  });
  let server = createServer();
  let client: AgentServerClient;
  try {
    let address = await server.listen();
    client = new AgentServerClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: TOKEN });
    const thread = await client.createThread({ agentId: simpleChatDescriptor.id, threadId: "durable-chat-thread" });
    const idleThread = await client.createThread({ agentId: simpleChatDescriptor.id, threadId: "idle-chat-thread" });

    const first = await client.startRun(thread.threadId, simpleChatDescriptor.id, { message: "Hello" }, 1);
    await waitForStatus(client, thread.threadId, "completed");
    const firstRunId = (first.result as { run_id: string }).run_id;
    assert.ok(firstRunId);
    assert.equal(((await client.getState(thread.threadId)).result as { values: Record<string, unknown> }).values.output, "Hello from turn one.");

    await server.close();
    server = createServer();
    address = await server.listen();
    client = new AgentServerClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: TOKEN });
    assert.equal((await client.getThread(thread.threadId)).status, "completed", "the host should rehydrate the existing thread");
    assert.equal((await client.getThread(idleThread.threadId)).status, "idle", "idle Durable threads should not block server startup");

    const second = await client.startRun(thread.threadId, simpleChatDescriptor.id, { message: "What is Pi Durable?" }, 2);
    await waitForStatus(client, thread.threadId, "completed");
    const secondRunId = (second.result as { run_id: string }).run_id;
    assert.ok(secondRunId);
    assert.notEqual(secondRunId, firstRunId);
    assert.equal(secondTurnSawFirstMessage, true, "the second Durable submission should include the existing conversation transcript");
    assert.equal(((await client.getState(thread.threadId)).result as { values: Record<string, unknown> }).values.output, "Pi Durable is the conversation runtime.");
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("real ResearchRunAgent runs through the generic HTTP host and protocol event stream", async () => {
  const directory = await mkdtemp(join(tmpdir(), "research-agent-server-"));
  const faux = fauxProvider();
  faux.setResponses([
    '{"needClarification":false,"question":"","verification":""}',
    "A brief about battery recycling.",
    '{"sufficient":true,"assignments":[]}',
    "# Battery recycling\n\nThe hosted report.",
  ].map((text) => fauxAssistantMessage([fauxText(text)])));
  const models = createModels();
  models.setProvider(faux.provider);
  const research = await createResearchRunAgent({
    cwd: directory,
    context: BACKGROUND_CONTEXT,
    models,
    model: { provider: "faux", modelId: "faux-1" },
    search: async (query) => ({ ok: true, results: [{ title: "Test", url: "https://example.test", content: "Evidence", query }] }),
    searchConfigured: true,
    env: { ALLOW_CLARIFICATION: "true", MAX_SUPERVISOR_ROUNDS: "1" },
  });
  const hosted = createResearchHostedAgent({ agent: research });
  const server = createAgentServer({ agents: [hosted], token: TOKEN, host: "127.0.0.1", port: 0, statePath: join(directory, "server.json") });
  try {
    const address = await server.listen();
    const client = new AgentServerClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: TOKEN });
    const thread = await client.createThread({ agentId: researchAgentDescriptor.id });
    const started = await client.startRun(thread.threadId, researchAgentDescriptor.id, { request: "Research battery recycling" }, 1);
    assert.equal((started.result as { run_id?: string }).run_id, thread.threadId);

    let completed = false;
    for await (const event of client.stream(thread.threadId, { channels: ["lifecycle", "custom"] })) {
      if (event.method === "lifecycle" && (event.params as { data: { event?: string } }).data.event === "completed") {
        completed = true;
        break;
      }
    }
    assert.equal(completed, true);
    assert.equal((await client.getThread(thread.threadId)).status, "completed");
    const state = await client.getState(thread.threadId, { commandId: 2 });
    assert.match(JSON.stringify(state.result), /The hosted report/);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

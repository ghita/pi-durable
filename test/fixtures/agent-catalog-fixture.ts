import type { AgentService } from "../../src/agent-server/agent-service.ts";

export function createFixtureAgent(): AgentService {
  const snapshot = {
    runId: "fixture-run",
    status: "completed" as const,
    updatedAt: 1,
    output: "fixture output",
  };
  return {
    descriptor: {
      id: "fixture",
      name: "Fixture",
      description: "Catalog loader fixture",
      threadPolicy: "multi-turn",
      capabilities: [],
    },
    async createThread() {},
    async startRun() { return snapshot; },
    async respond() { return snapshot; },
    async getSnapshot() { return snapshot; },
    async *watch() { yield { snapshot }; },
    async close() {},
  };
}

import { resolve, join } from "node:path";
import { createResearchRuntime } from "../research-config.ts";
import type { AgentFactoryContext } from "./catalog.ts";
import { createDurableConversationService } from "./durable-conversation.ts";
import type { AgentService } from "./agent-service.ts";
import type { AgentDescriptor } from "./types.ts";

export const simpleChatDescriptor: AgentDescriptor = {
  id: "simple-chat",
  name: "Simple Chat",
  description: "A multi-turn assistant backed by one durable conversation per thread.",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string", minLength: 1, description: "The message to send to the assistant." } },
    required: ["message"],
    additionalProperties: false,
  },
  threadPolicy: "multi-turn",
  capabilities: ["streaming"],
};

export interface SimpleChatAgentOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  dataDirectory?: string;
  models?: ReturnType<typeof createResearchRuntime>["models"];
  model?: ReturnType<typeof createResearchRuntime>["model"];
}

export function createSimpleChatAgentService(options: SimpleChatAgentOptions = {}): AgentService {
  const env = options.env ?? process.env;
  const runtime = options.models && options.model ? undefined : createResearchRuntime(env);
  return createDurableConversationService({
    descriptor: structuredClone(simpleChatDescriptor),
    dataDirectory: resolve(options.dataDirectory ?? join(options.cwd ?? process.cwd(), ".agent-server", "conversations")),
    models: options.models ?? runtime!.models,
    agent: {
      model: options.model ?? runtime!.model,
      instructions: "You are a helpful, concise assistant. Use the conversation history to answer follow-up questions.",
    },
  });
}

/** Factory used by a local manifest. The catalog applies the shared protocol adapter. */
export async function createSimpleChatAgentFromManifest(context: AgentFactoryContext): Promise<AgentService> {
  return createSimpleChatAgentService({ cwd: context.manifestDirectory, env: context.env });
}

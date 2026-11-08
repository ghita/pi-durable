import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";

export function createThinkTool(): ToolRegistration {
  return defineTool({
    name: "think_tool",
    description: "Think through the evidence and decide what to research next.",
    parameters: obj({ thought: str({ description: "The reasoning needed to choose the next research action." }) }),
    replay: "safe",
    execute: async ({ thought }) => ({ output: [{ type: "text", text: `Thought recorded: ${thought}` }] }),
  });
}

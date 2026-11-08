import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { ResearcherDataDoc } from "./researcher-data.ts";

export function createResearchCompleteTool(): ToolRegistration {
  return defineTool({
    name: "research_complete",
    description: "Finish this assignment with the key findings gathered so far.",
    parameters: obj({ findings: str({ description: "The key findings gathered for this assignment." }) }),
    replay: "safe",
    execute: async ({ findings }, api, context) => {
      await api.commit(async (tx) => {
        const state = await tx.doc(ResearcherDataDoc, api.conversationId);
        state.findings = findings;
      }, context);
      return {
        output: [{ type: "text", text: findings }],
        control: { terminate: true },
      };
    },
  });
}

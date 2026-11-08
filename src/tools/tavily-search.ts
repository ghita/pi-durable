import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import type { SearchProvider, SearchResult } from "./types.ts";
import { ResearcherDataDoc } from "./researcher-data.ts";

export function createTavilySearchTool(search: SearchProvider): ToolRegistration {
  return defineTool({
    name: "tavily_search",
    description: "Search the web with Tavily and return source snippets with URLs.",
    parameters: obj({ query: str({ description: "A focused web search query." }) }),
    replay: "safe",
    execute: async ({ query }, api, context) => {
      const allowed = await api.commit(async (tx) => {
        const state = await tx.doc(ResearcherDataDoc, api.conversationId);
        if (state.searches >= state.maxSearches) return false;
        state.searches += 1;
        return true;
      }, context);
      if (!allowed) {
        return {
          output: [{ type: "text", text: "The search budget is exhausted. Stop searching and synthesize the findings now." }],
          control: { terminate: true },
        };
      }

      let result: SearchResult;
      try {
        result = await search(query, context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await api.commit(async (tx) => {
          const state = await tx.doc(ResearcherDataDoc, api.conversationId);
          state.searchFailures.push(message);
        }, context);
        throw new Error(`Web research unavailable: ${message}`);
      }
      if (!result.ok) {
        await api.commit(async (tx) => {
          const state = await tx.doc(ResearcherDataDoc, api.conversationId);
          state.searchFailures.push(result.error);
        }, context);
        throw new Error(`Web research unavailable: ${result.error}`);
      }
      await api.commit(async (tx) => {
        const state = await tx.doc(ResearcherDataDoc, api.conversationId);
        for (const source of result.results) {
          if (!state.sources.some((existing) => existing.url === source.url && existing.query === source.query)) {
            state.sources.push(source);
          }
        }
      }, context);
      return { output: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });
}

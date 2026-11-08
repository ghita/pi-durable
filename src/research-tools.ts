import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { createProjectSkillTools, loadProjectSkills, projectSkillsSection } from "./tools/project-skills.ts";
import { createResearchCompleteTool } from "./tools/research-complete.ts";
import { createTavilySearchTool } from "./tools/tavily-search.ts";
import { createThinkTool } from "./tools/think.ts";
import type { SearchProvider } from "./tools/types.ts";

export { ResearcherDataDoc, type ResearcherData } from "./tools/researcher-data.ts";
export type { SearchProvider, SearchResult, SearchSource } from "./tools/types.ts";

export async function createResearchToolsExtension(
  search: SearchProvider,
  skillsDirectory?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Extension> {
  const skills = await loadProjectSkills(env, skillsDirectory);
  const tools: ToolRegistration[] = [
    createTavilySearchTool(search),
    createThinkTool(),
    createResearchCompleteTool(),
    ...createProjectSkillTools(skills),
  ];
  return defineExtension({
    name: "deep-research-tools",
    tools,
    sections: [projectSkillsSection(skills)],
  });
}

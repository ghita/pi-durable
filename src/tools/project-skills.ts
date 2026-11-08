import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readFile, readdir, realpath } from "node:fs/promises";
import { defineTool, section, type ToolRegistration } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { ResearcherDataDoc } from "./researcher-data.ts";

export type ProjectSkill = { name: string; description: string; directory: string };

function defaultSkillsDirectory(env: NodeJS.ProcessEnv): string {
  const override = env.UI_REACT_SKILLS_DIR?.trim();
  if (override) return resolve(override);
  const appData = env.APPDATA?.trim();
  if (process.platform === "win32" && appData) return join(appData, "ui-react", "skills");
  return join(env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "ui-react", "skills");
}

function within(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

function frontmatter(text: string): { name?: string; description?: string } {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return {};
  const lines = match[1]!.split(/\r?\n/);
  const field = (name: string) => lines.find((line) => line.startsWith(`${name}:`))?.slice(name.length + 1).trim().replace(/^['"]|['"]$/g, "");
  return { name: field("name"), description: field("description") };
}

export async function discoverProjectSkills(directory: string): Promise<ProjectSkill[]> {
  let root: string;
  try {
    root = await realpath(directory);
  } catch {
    return [];
  }
  const result: ProjectSkill[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const skillDirectory = await realpath(join(root, entry.name));
      if (!within(root, skillDirectory)) continue;
      const manifestPath = await realpath(join(skillDirectory, "SKILL.md"));
      if (!within(skillDirectory, manifestPath)) continue;
      const text = await readFile(manifestPath, "utf8");
      const metadata = frontmatter(text);
      const name = metadata.name ?? entry.name;
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) continue;
      const description = metadata.description ?? text.split(/\r?\n/).find((line) => line.trim() && !line.startsWith("#")) ?? "Project skill instructions.";
      result.push({ name, description, directory: skillDirectory });
    } catch {
      // Ignore malformed, unreadable, or incomplete skill directories.
    }
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

async function readSkillFile(skill: ProjectSkill, filePath: string): Promise<string> {
  const normalized = filePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Skill file path must be a non-empty relative path without dot segments.");
  }
  const canonicalRoot = await realpath(skill.directory);
  const canonicalPath = await realpath(resolve(skill.directory, ...segments));
  if (!within(canonicalRoot, canonicalPath)) throw new Error("Skill file path escapes its skill directory.");
  return readFile(canonicalPath, "utf8");
}

function skillCatalog(skills: readonly ProjectSkill[]): string {
  if (skills.length === 0) return "";
  return [
    "## Available project skills",
    "Choose a skill when its description fits the research assignment. Load its full SKILL.md with `load_skill` before following it.",
    "Use `read_skill_file` for supporting files referenced by an activated skill, only when needed.",
    ...skills.map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n");
}

export function projectSkillsSection(skills: readonly ProjectSkill[]) {
  return section("project-skills", () => skillCatalog(skills), { tag: false });
}

export function createProjectSkillTools(skills: readonly ProjectSkill[]): ToolRegistration[] {
  if (skills.length === 0) return [];

  const loadSkill = defineTool({
    name: "load_skill",
    description: "Load the full instructions for an available project skill. Use the exact name from the available-skills list.",
    parameters: obj({ name: str({ description: "Exact name of an available project skill." }) }),
    replay: "safe",
    execute: async ({ name }, api, context) => {
      const skill = skills.find((candidate) => candidate.name === name);
      if (!skill) throw new Error(`Unknown project skill: ${name}`);
      const text = await readSkillFile(skill, "SKILL.md");
      await api.commit(async (tx) => {
        const state = await tx.doc(ResearcherDataDoc, api.conversationId);
        if (!state.activatedSkills.includes(name)) state.activatedSkills.push(name);
      }, context);
      return { output: [{ type: "text", text }] };
    },
  });

  const readSkillSupportingFile = defineTool({
    name: "read_skill_file",
    description: "Read a supporting file inside an activated project skill, when its SKILL.md refers to it.",
    parameters: obj({
      name: str({ description: "Exact name of the activated project skill." }),
      path: str({ description: "Relative path within that skill directory." }),
    }),
    replay: "safe",
    execute: async ({ name, path }, api, context) => {
      const state = await api.snapshot(ResearcherDataDoc, api.conversationId, context);
      if (!state?.activatedSkills.includes(name)) throw new Error(`Activate project skill ${name} before reading its supporting files.`);
      const skill = skills.find((candidate) => candidate.name === name);
      if (!skill) throw new Error(`Unknown project skill: ${name}`);
      const text = await readSkillFile(skill, path);
      return { output: [{ type: "text", text }] };
    },
  });

  return [loadSkill, readSkillSupportingFile];
}

export async function loadProjectSkills(env: NodeJS.ProcessEnv, directory?: string): Promise<ProjectSkill[]> {
  return discoverProjectSkills(directory?.trim() ? resolve(directory) : defaultSkillsDirectory(env));
}

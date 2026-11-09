import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import type { AgentServiceFactory } from "./agent-service.ts";
import { createHostedAgentAdapter } from "./host-adapter.ts";
import type { AgentCatalog, AgentDescriptor, HostedAgent } from "./types.ts";

export interface AgentFactoryContext {
  agentId: string;
  manifestDirectory: string;
  env: NodeJS.ProcessEnv;
}

export type { AgentServiceFactory } from "./agent-service.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateAgentDescriptor(value: unknown, manifestId: string): asserts value is AgentDescriptor {
  if (!isRecord(value)) throw new Error(`Agent factory for "${manifestId}" has no descriptor.`);
  if (value.id !== manifestId) {
    throw new Error(`Agent descriptor ID "${String(value.id)}" does not match manifest ID "${manifestId}".`);
  }
  if (!/^[a-z][a-z0-9._-]*$/.test(manifestId)) throw new Error(`Invalid agent descriptor ID "${manifestId}".`);
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error(`Agent "${manifestId}" must have a non-empty name.`);
  if (typeof value.description !== "string") throw new Error(`Agent "${manifestId}" must have a description.`);
  if (value.inputSchema !== undefined && !isRecord(value.inputSchema)) throw new Error(`Agent "${manifestId}" inputSchema must be a JSON Schema object.`);
  if (value.threadPolicy !== "single-case" && value.threadPolicy !== "multi-turn") {
    throw new Error(`Agent "${manifestId}" has an invalid threadPolicy.`);
  }
  if (!Array.isArray(value.capabilities) || !value.capabilities.every((capability) => ["interrupts", "streaming"].includes(String(capability)))) {
    throw new Error(`Agent "${manifestId}" has invalid capabilities.`);
  }
}

function parseFactoryReference(reference: string): { modulePath: string; exportName: string } {
  const separator = reference.lastIndexOf(":");
  if (separator <= 0 || separator === reference.length - 1) {
    throw new Error(`Invalid agent factory reference "${reference}"; expected "./module.js:exportName".`);
  }
  const modulePath = reference.slice(0, separator);
  const exportName = reference.slice(separator + 1);
  if (!modulePath.startsWith("./") && !modulePath.startsWith("../") && !isAbsolute(modulePath)) {
    throw new Error(`Agent modules must be local paths, not package or URL specifiers: "${modulePath}".`);
  }
  return { modulePath, exportName };
}

async function importFactory(reference: string, directory: string): Promise<AgentServiceFactory> {
  const { modulePath, exportName } = parseFactoryReference(reference);
  const file = isAbsolute(modulePath) ? modulePath : resolve(directory, modulePath);
  let module: Record<string, unknown>;
  try {
    module = await import(pathToFileURL(file).href) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Could not import agent module "${file}": ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const factory = module[exportName];
  if (typeof factory !== "function") throw new Error(`Export "${exportName}" from "${file}" is not a factory function.`);
  return factory as AgentServiceFactory;
}

/** Load trusted local factories from a server manifest and construct the configured catalog. */
export async function loadAgentCatalog(manifestPath: string, env: NodeJS.ProcessEnv = process.env): Promise<AgentCatalog> {
  const absoluteManifestPath = resolve(manifestPath);
  const manifestDirectory = dirname(absoluteManifestPath);
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(absoluteManifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read agent server manifest "${absoluteManifestPath}": ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!isRecord(decoded) || !isRecord(decoded.agents) || Object.keys(decoded.agents).length === 0) {
    throw new Error("Agent server manifest must contain a non-empty agents object.");
  }
  if (decoded.env !== undefined && typeof decoded.env !== "string") throw new Error("Manifest env must be a local path string.");
  if (typeof decoded.env === "string") {
    const envPath = isAbsolute(decoded.env) ? decoded.env : resolve(manifestDirectory, decoded.env);
    const dotenvEnv: Record<string, string> = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const result = dotenv.config({ path: envPath, processEnv: dotenvEnv });
    Object.assign(env, dotenvEnv);
    if (result.error && (result.error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Could not load manifest environment file "${envPath}": ${result.error.message}`, { cause: result.error });
    }
  }

  const agents = new Map<string, HostedAgent>();
  try {
    for (const [agentId, reference] of Object.entries(decoded.agents)) {
      if (!/^[a-z][a-z0-9._-]*$/.test(agentId)) throw new Error(`Invalid catalog agent ID "${agentId}".`);
      if (typeof reference !== "string") throw new Error(`Manifest entry "${agentId}" must be a module-export string.`);
      if (agents.has(agentId)) throw new Error(`Duplicate agent ID "${agentId}".`);
      const factory = await importFactory(reference, manifestDirectory);
      const service = await factory({ agentId, manifestDirectory, env });
      try {
        if (!service || typeof service !== "object" || typeof service.createThread !== "function"
          || typeof service.startRun !== "function" || typeof service.respond !== "function"
          || typeof service.getSnapshot !== "function" || typeof service.watch !== "function" || typeof service.close !== "function"
          || (service.initialize !== undefined && typeof service.initialize !== "function")) {
          throw new Error(`Factory for "${agentId}" did not return an AgentService.`);
        }
        validateAgentDescriptor(service.descriptor, agentId);
        agents.set(agentId, createHostedAgentAdapter(service));
      } catch (error) {
        if (service && typeof service.close === "function") await service.close().catch(() => {});
        throw error;
      }
    }
  } catch (error) {
    await Promise.all([...agents.values()].map((agent) => agent.close().catch(() => {})));
    throw new Error(`Failed to initialize the configured agent catalog: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  return {
    agents,
    close: async () => { await Promise.all([...agents.values()].map((agent) => agent.close())); },
  };
}

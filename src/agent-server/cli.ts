import { resolve } from "node:path";
import { loadAgentCatalog } from "./catalog.ts";
import { createAgentServer } from "./server.ts";

function integerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer.`);
  return parsed;
}

async function main(): Promise<void> {
  const manifestPath = resolve(process.env.AGENT_SERVER_MANIFEST ?? "agent-server.json");
  const catalog = await loadAgentCatalog(manifestPath);
  const token = process.env.AGENT_SERVER_TOKEN;
  if (!token) {
    await catalog.close();
    throw new Error("Set AGENT_SERVER_TOKEN in the environment or the manifest's env file before starting the server.");
  }
  const host = process.env.AGENT_SERVER_HOST ?? "127.0.0.1";
  const server = createAgentServer({
    catalog,
    token,
    host,
    port: integerEnv("AGENT_SERVER_PORT", 3000),
    statePath: process.env.AGENT_SERVER_STATE_PATH ? resolve(process.env.AGENT_SERVER_STATE_PATH) : undefined,
    maxConcurrentThreads: integerEnv("AGENT_SERVER_MAX_CONCURRENT_THREADS", 4),
    trustProxy: process.env.AGENT_SERVER_TRUST_PROXY === "true",
    trustedProxyAddresses: (process.env.AGENT_SERVER_TRUSTED_PROXY_ADDRESSES ?? "").split(",").map((address) => address.trim()).filter(Boolean),
  });
  const address = await server.listen();
  console.log(`Agent server listening on http://${address.host}:${address.port}`);
  console.log(`Catalog: ${[...catalog.agents.keys()].join(", ")}`);

  await new Promise<void>((resolveShutdown) => {
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      void server.close().then(resolveShutdown, (error) => {
        console.error("Server shutdown failed:", error);
        process.exitCode = 1;
        resolveShutdown();
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

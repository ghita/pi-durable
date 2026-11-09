import "dotenv/config";
import { AgentServerClient } from "./agent-server/client.ts";
import { runCli } from "./cli-adapter.ts";

async function ask(question: string): Promise<string> {
  process.stderr.write(question);
  const readline = await import("node:readline/promises");
  const terminal = readline.createInterface({ input: process.stdin, output: process.stderr });
  const interrupted = new AbortController();
  terminal.once("SIGINT", () => interrupted.abort());
  try {
    return await terminal.question("", { signal: interrupted.signal });
  } catch (error) {
    if (interrupted.signal.aborted) {
      const abort = new Error("Terminal input interrupted.");
      abort.name = "AbortError";
      throw abort;
    }
    throw error;
  } finally {
    terminal.close();
  }
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!process.env.AGENT_SERVER_TOKEN && !args.some((argument) => argument === "--help" || argument === "-h")) {
    process.stderr.write("Set AGENT_SERVER_TOKEN in .env or the environment to use the HTTP agent server.\n");
    process.exitCode = 1;
    return;
  }

  const client = new AgentServerClient({
    baseUrl: process.env.AGENT_SERVER_URL ?? "http://127.0.0.1:3000",
    token: process.env.AGENT_SERVER_TOKEN ?? "",
  });
  process.exitCode = await runCli(args, {
    client,
    io: {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      ask,
    },
  });
}

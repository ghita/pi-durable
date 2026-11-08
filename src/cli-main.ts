import "dotenv/config";
import { createResearchRunAgent } from "./research-run-agent.ts";
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
  let agent: Awaited<ReturnType<typeof createResearchRunAgent>> | undefined;
  let exitCode = 1;
  try {
    agent = await createResearchRunAgent({ recoverOnStart: false });
    exitCode = await runCli(process.argv.slice(2), {
      agent,
      io: {
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
        ask,
      },
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    if (agent) await agent.close().catch((error: unknown) => {
      process.stderr.write(`Could not close research service: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }
  process.exitCode = exitCode;
}

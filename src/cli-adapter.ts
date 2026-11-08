import {
  DEEP_RESEARCH_AGENT_ID,
  type ResearchRunAgent,
  type ResearchRunSnapshot,
} from "./research-run-agent.ts";

export type CliIO = {
  stdout(text: string): void;
  stderr(text: string): void;
  ask(question: string): Promise<string>;
};

export type CliDependencies = { agent: ResearchRunAgent; io: CliIO };

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function usage(): string {
  return [
    "Usage:",
    '  deep-research "<request>"',
    "  deep-research resume <run-id>",
    "  deep-research list",
  ].join("\n");
}

function normalizeArgs(args: string[]): string[] {
  return args[0] === "--" ? args.slice(1) : args;
}

function isInterrupted(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || (error as NodeJS.ErrnoException).code === "ABORT_ERR");
}

function progressLine(snapshot: ResearchRunSnapshot): string {
  return `${snapshot.phase ?? snapshot.status} · ${snapshot.status}`;
}

async function showRun(
  initial: ResearchRunSnapshot,
  dependencies: CliDependencies,
): Promise<number> {
  let snapshot = initial;
  let lastProgress: string | undefined;
  const showProgress = (next: ResearchRunSnapshot) => {
    const line = progressLine(next);
    if (line === lastProgress) return;
    lastProgress = line;
    dependencies.io.stderr(`Progress: ${line}\n`);
  };

  while (true) {
    showProgress(snapshot);
    if (snapshot.status === "completed") {
      dependencies.io.stdout(`${snapshot.report ?? ""}\n`);
      return 0;
    }
    if (snapshot.status === "failed") {
      dependencies.io.stderr(`${snapshot.error ?? "Research run failed."}\n`);
      return 1;
    }
    if (snapshot.status === "awaiting_clarification") {
      if (!snapshot.pendingQuestion) throw new Error("Clarification checkpoint is missing its pending question.");
      const answer = await dependencies.io.ask(`${snapshot.pendingQuestion}\n> `);
      snapshot = await dependencies.agent.answerClarification(snapshot.runId, answer);
      continue;
    }

    let pausedForClarification = false;
    for await (const update of dependencies.agent.watch(snapshot.runId)) {
      snapshot = update;
      showProgress(snapshot);
      if (snapshot.status === "awaiting_clarification") {
        pausedForClarification = true;
        break;
      }
      if (snapshot.status === "completed") {
        dependencies.io.stdout(`${snapshot.report ?? ""}\n`);
        return 0;
      }
      if (snapshot.status === "failed") {
        dependencies.io.stderr(`${snapshot.error ?? "Research run failed."}\n`);
        return 1;
      }
    }
    if (!pausedForClarification) {
      const latest = await dependencies.agent.get(snapshot.runId);
      if (!latest) throw new Error(`Research run ${snapshot.runId} disappeared.`);
      snapshot = latest;
    }
  }
}

export async function runCli(args: string[], dependencies: CliDependencies): Promise<number> {
  const normalized = normalizeArgs(args);
  let activeRunId: string | undefined;
  try {
    if (normalized.includes("--help") || normalized.includes("-h")) {
      dependencies.io.stdout(`${usage()}\n`);
      return 0;
    }
    if (normalized[0] === "list") {
      const runs = await dependencies.agent.listRuns();
      dependencies.io.stdout(runs.length
        ? `${runs.map((run) => `${run.runId}\t${run.status}\t${run.request}`).join("\n")}\n`
        : "No research runs.\n");
      return 0;
    }
    if (normalized[0] === "resume") {
      const runId = normalized[1];
      if (!runId || normalized.length !== 2) {
        dependencies.io.stderr("Usage: deep-research resume <run-id>\n");
        return 2;
      }
      if (!RUN_ID_PATTERN.test(runId)) {
        dependencies.io.stderr("Run ID must be a UUID printed by deep-research.\n");
        return 2;
      }
      activeRunId = runId;
      const snapshot = await dependencies.agent.resume(runId);
      return await showRun(snapshot, dependencies);
    }

    const request = normalized.join(" ").trim();
    if (!request) {
      dependencies.io.stderr(`${usage()}\n`);
      return 2;
    }

    const snapshot = await dependencies.agent.start({ agentId: DEEP_RESEARCH_AGENT_ID, request });
    activeRunId = snapshot.runId;
    dependencies.io.stderr(`Run ID: ${snapshot.runId}\n`);
    return await showRun(snapshot, dependencies);
  } catch (error) {
    if (isInterrupted(error)) {
      dependencies.io.stderr(activeRunId
        ? `Stopped. Resume with: deep-research resume ${activeRunId}\n`
        : "Stopped.\n");
      return 130;
    }
    dependencies.io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

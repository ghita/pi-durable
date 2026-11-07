import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

function copilotCredentialPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.COPILOT_AUTH_FILE?.trim();
  if (override) return override;
  const appData = env.APPDATA?.trim();
  if (process.platform === "win32" && appData) return join(appData, "ui-react", "copilot-auth.json");
  return join(env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "ui-react", "copilot-auth.json");
}

function isCredential(value: unknown): value is Credential {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.type === "api_key") return record.key === undefined || typeof record.key === "string";
  return record.type === "oauth" && typeof record.refresh === "string" && typeof record.access === "string" && typeof record.expires === "number";
}

async function readFileContents(path: string): Promise<Record<string, Credential | undefined>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("credential file must contain an object");
    for (const [provider, value] of Object.entries(parsed)) {
      if (value !== undefined && !isCredential(value)) throw new Error(`invalid credential for provider ${provider}`);
    }
    return parsed as Record<string, Credential | undefined>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Unable to read credential file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeFileContents(path: string, value: Record<string, Credential | undefined>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** File-backed Pi credential store compatible with the existing UI React Copilot auth file. */
export class FileCredentialStore implements CredentialStore {
  readonly #path: string;
  readonly #chains = new Map<string, Promise<unknown>>();

  constructor(path = copilotCredentialPath()) {
    this.#path = path;
  }

  private enqueue<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(providerId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.#chains.set(providerId, current);
    return current.finally(() => {
      if (this.#chains.get(providerId) === current) this.#chains.delete(providerId);
    });
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const credentials = await readFileContents(this.#path);
    options?.signal?.throwIfAborted();
    return credentials[providerId];
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const credentials = await readFileContents(this.#path);
    options?.signal?.throwIfAborted();
    return Object.entries(credentials)
      .filter((entry): entry is [string, Credential] => entry[1] !== undefined)
      .map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  modify(
    providerId: string,
    update: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      options?.signal?.throwIfAborted();
      const credentials = await readFileContents(this.#path);
      const next = await update(credentials[providerId]);
      options?.signal?.throwIfAborted();
      if (next === undefined) delete credentials[providerId];
      else credentials[providerId] = next;
      await writeFileContents(this.#path, credentials);
      return next;
    });
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    await this.modify(providerId, async () => undefined, options);
  }
}

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type AgentLike,
  CodexAgent,
} from "smithers-orchestrator";

type CodexOptions = NonNullable<ConstructorParameters<typeof CodexAgent>[0]>;

type RegisteredCodexCredential =
  | { provider: "codex"; configDir: string }
  | { provider: "openai-api"; apiKey: string };

type AccountsFile = {
  accounts?: Array<{
    provider?: unknown;
    configDir?: unknown;
    apiKey?: unknown;
  }>;
};

function smithersHome(env: NodeJS.ProcessEnv): string {
  return resolve(
    env.SMITHERS_HOME?.trim()
      || join(env.HOME?.trim() || homedir(), ".smithers"),
  );
}

/**
 * Read the Codex-family credentials registered by `smithers agents add`.
 * Malformed or absent registries are deliberately treated as empty so a
 * workflow can still fall through to its non-Codex backup.
 */
export function registeredCodexCredentials(
  env: NodeJS.ProcessEnv = process.env,
): RegisteredCodexCredential[] {
  let parsed: AccountsFile;
  try {
    parsed = JSON.parse(
      readFileSync(join(smithersHome(env), "accounts.json"), "utf8"),
    ) as AccountsFile;
  } catch {
    return [];
  }

  if (!Array.isArray(parsed.accounts)) return [];

  const seen = new Set<string>();
  const credentials: RegisteredCodexCredential[] = [];
  for (const account of parsed.accounts) {
    if (account?.provider === "codex" && typeof account.configDir === "string") {
      const configDir = account.configDir.trim();
      const key = `codex:${configDir}`;
      if (configDir && !seen.has(key)) {
        seen.add(key);
        credentials.push({ provider: "codex", configDir });
      }
    } else if (account?.provider === "openai-api" && typeof account.apiKey === "string") {
      const apiKey = account.apiKey.trim();
      const key = `openai-api:${apiKey}`;
      if (apiKey && !seen.has(key)) {
        seen.add(key);
        credentials.push({ provider: "openai-api", apiKey });
      }
    }
  }
  return credentials;
}

/**
 * Build one sequential failover chain:
 *
 * 1. ambient/default Codex auth;
 * 2. every registered Codex/OpenAI account, with the same role model/options;
 * 3. the supplied non-Codex backups.
 *
 * Engine agent arrays are sequential, so a successful Codex attempt prevents
 * Claude, Kimi, and other providers from running.
 */
export function codexFirst(
  options: CodexOptions,
  fallbacks: AgentLike[] = [],
  env: NodeJS.ProcessEnv = process.env,
): AgentLike[] {
  const registered = registeredCodexCredentials(env)
    .filter((credential) => {
      if (credential.provider === "codex") {
        return credential.configDir !== (options.configDir || env.CODEX_HOME?.trim());
      }
      return credential.apiKey !== (options.apiKey || env.OPENAI_API_KEY?.trim());
    })
    .map((credential) => new CodexAgent({
      ...options,
      configDir: credential.provider === "codex" ? credential.configDir : undefined,
      apiKey: credential.provider === "openai-api" ? credential.apiKey : undefined,
    }));

  return [new CodexAgent(options), ...registered, ...fallbacks];
}

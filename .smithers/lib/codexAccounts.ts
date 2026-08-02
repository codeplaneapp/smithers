import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type AgentLike, CodexAgent } from "smthrs";

type CodexOptions = NonNullable<ConstructorParameters<typeof CodexAgent>[0]>;

type RegisteredCodexCredential = { provider: "codex"; configDir: string } | { provider: "openai-api"; apiKey: string };

type AccountsFile = {
  accounts?: Array<{
    provider?: unknown;
    configDir?: unknown;
    apiKey?: unknown;
  }>;
};

function smithersHome(env: NodeJS.ProcessEnv): string {
  return resolve(env.SMITHERS_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".smithers"));
}

/**
 * Read the Codex-family credentials registered by `smithers agents add`.
 * Malformed or absent registries are deliberately treated as empty so a
 * workflow can still fall through to its non-Codex backup.
 */
export function registeredCodexCredentials(env: NodeJS.ProcessEnv = process.env): RegisteredCodexCredential[] {
  let parsed: AccountsFile;
  try {
    parsed = JSON.parse(readFileSync(join(smithersHome(env), "accounts.json"), "utf8")) as AccountsFile;
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
 * True when Codex is operator-paused, which flips every codex-first chain to
 * its fallbacks (Sonnet fills the Luna/Terra seats, Fable fills the Sol
 * seats). Set it while the Codex subscription is rate limited so new runs
 * never burn attempts on a dead provider or park at waiting-quota.
 *
 * Two switches, either works:
 *   - env `SMITHERS_CODEX_PAUSED` (truthy pauses; `0`/`false`/`off`/`no`
 *     force-unpauses even when the marker file exists);
 *   - marker file `<SMITHERS_HOME>/codex-paused.json`. An optional ISO-8601
 *     `until` field auto-unpauses the chains once the quota window resets; a
 *     marker without `until` (or with a malformed body) pauses until deleted.
 */
export function codexPaused(env: NodeJS.ProcessEnv = process.env): boolean {
  const envFlag = env.SMITHERS_CODEX_PAUSED?.trim().toLowerCase();
  if (envFlag) {
    return !["0", "false", "off", "no"].includes(envFlag);
  }
  let raw: string;
  try {
    raw = readFileSync(join(smithersHome(env), "codex-paused.json"), "utf8");
  } catch {
    return false;
  }
  try {
    const marker = JSON.parse(raw) as { until?: unknown };
    if (typeof marker?.until === "string") {
      const until = Date.parse(marker.until);
      if (Number.isFinite(until)) return Date.now() < until;
    }
    return true;
  } catch {
    // The operator created the file; a body we cannot parse still means pause.
    return true;
  }
}

/**
 * Build one sequential failover chain:
 *
 * 1. ambient/default Codex auth;
 * 2. every registered Codex/OpenAI account, with the same role model/options;
 * 3. the supplied non-Codex backups.
 *
 * Engine agent arrays are sequential, so a successful Codex attempt prevents
 * Claude, Kimi, and other providers from running. While `codexPaused` and a
 * fallback exists, the chain is the fallbacks alone; a chain with no fallback
 * keeps Codex rather than going empty.
 */
export function codexFirst(
  options: CodexOptions,
  fallbacks: AgentLike[] = [],
  env: NodeJS.ProcessEnv = process.env,
): AgentLike[] {
  if (fallbacks.length > 0 && codexPaused(env)) {
    return [...fallbacks];
  }
  const registered = registeredCodexCredentials(env)
    .filter((credential) => {
      if (credential.provider === "codex") {
        return credential.configDir !== (options.configDir || env.CODEX_HOME?.trim());
      }
      return credential.apiKey !== (options.apiKey || env.OPENAI_API_KEY?.trim());
    })
    .map(
      (credential) =>
        new CodexAgent({
          ...options,
          configDir: credential.provider === "codex" ? credential.configDir : undefined,
          apiKey: credential.provider === "openai-api" ? credential.apiKey : undefined,
        }),
    );

  return [new CodexAgent(options), ...registered, ...fallbacks];
}

/**
 * Build a Codex-first chain without ambient auth or API-key credentials.
 *
 * Public, untrusted work must use subscription config directories explicitly:
 * the Codex CLI can read its auth before entering the command sandbox, while
 * model-spawned commands remain unable to read the real config directory.
 */
export function subscriptionCodexFirst(
  options: CodexOptions,
  fallbacks: AgentLike[] = [],
  env: NodeJS.ProcessEnv = process.env,
): AgentLike[] {
  if (options.apiKey) {
    throw new Error("subscriptionCodexFirst does not accept API-key credentials");
  }
  if (fallbacks.length > 0 && codexPaused(env)) {
    return [...fallbacks];
  }

  const configDirs = [
    options.configDir?.trim(),
    ...registeredCodexCredentials(env)
      .filter(
        (credential): credential is Extract<RegisteredCodexCredential, { provider: "codex" }> =>
          credential.provider === "codex",
      )
      .map((credential) => credential.configDir),
  ].filter((configDir): configDir is string => Boolean(configDir));

  const seen = new Set<string>();
  const subscriptions = configDirs.flatMap((configDir) => {
    if (seen.has(configDir)) return [];
    seen.add(configDir);
    return [new CodexAgent({ ...options, configDir, apiKey: undefined })];
  });

  return [...subscriptions, ...fallbacks];
}

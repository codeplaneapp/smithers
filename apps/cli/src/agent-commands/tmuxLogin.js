import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listAccounts } from "@smthrs/accounts";
import { readClaudeCredentials } from "@smthrs/usage";
import { findDuplicateAccounts, formatAccountIdentity, readAccountIdentity } from "./accountIdentity.js";
import {
  SUBSCRIPTION_DIR_ENV_VAR,
  SUBSCRIPTION_LOGIN_ARGS,
  SUBSCRIPTION_LOGIN_BIN,
  runAgentAdd,
} from "./runAgentAdd.js";

/** @typedef {import("@smthrs/accounts").AccountProvider} AccountProvider */

/**
 * Per-provider probe for "did the browser login actually complete?". These are
 * the credential artifacts each CLI writes into its config dir on successful
 * auth; presence of onboarding scratch files (themes, settings) deliberately
 * does not count.
 *
 * @type {Record<string, (configDir: string) => boolean>}
 */
const CREDENTIAL_PROBES = {
  // Claude Code writes `.credentials.json` on Linux, but on macOS it stores
  // the OAuth token in a per-config-dir Keychain item instead. `.claude.json`
  // gains an `oauthAccount` object the moment login completes on every
  // platform, so it doubles as the storage-agnostic completion marker.
  "claude-code": (configDir) => claudeCredentialsUsable(configDir),
  codex: (configDir) => existsSync(join(configDir, "auth.json")),
  kimi: (configDir) => existsSync(join(configDir, "credentials.json")) || existsSync(join(configDir, "auth.json")),
  grok: (configDir) => existsSync(join(configDir, "auth.json")),
  antigravity: (configDir) =>
    existsSync(join(configDir, "oauth_creds.json")) || existsSync(join(configDir, "credentials.json")),
};

/**
 * Whether the account holds a Claude OAuth token it can actually use. Reads the
 * same credential source as the usage probe, so "logged in" means the same
 * thing to `agents add` as it does to `smithers usage`.
 *
 * @param {string} configDir
 */
function claudeCredentialsUsable(configDir) {
  const creds = readClaudeCredentials({ configDir });
  if (!creds) return false;
  return typeof creds.expiresAt !== "number" || creds.expiresAt > Date.now();
}

/** @param {string} statePath */
function claudeStateShowsLogin(statePath) {
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    return Boolean(state && typeof state === "object" && state.oauthAccount);
  } catch {
    return false;
  }
}

/** @param {NodeJS.ProcessEnv} [env] */
export function tmuxAvailable(env = process.env) {
  const result = spawnSync("tmux", ["-V"], { env, encoding: "utf8" });
  return result.status === 0;
}

/**
 * tmux session names reject `.` and `:`; collapse anything unsafe to `-`.
 *
 * @param {string} label
 */
export function loginSessionName(label) {
  return `smithers-login-${label.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
}

/**
 * @param {AccountProvider} provider
 * @param {string} configDir
 */
export function credentialsPresent(provider, configDir) {
  const probe = CREDENTIAL_PROBES[provider];
  return probe ? probe(configDir) : false;
}

/** @param {string} value */
function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Login arguments for the tmux session. Claude Code's bare REPL makes a fresh
 * config dir walk theme + login-method onboarding before it will open the
 * browser; `claude auth login --claudeai` goes straight to the subscription
 * flow. That subcommand is not in older CLIs, so probe for it and fall back to
 * the REPL (where the user types `/login`) when it is missing.
 *
 * @param {AccountProvider} provider
 * @param {string} configDir
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
function resolveLoginArgs(provider, configDir, env) {
  if (provider === "claude-code" && claudeSupportsAuthLogin(env)) {
    return ["auth", "login", "--claudeai"];
  }
  const rawArgs = SUBSCRIPTION_LOGIN_ARGS[provider] ?? [];
  return typeof rawArgs === "function" ? rawArgs(configDir) : rawArgs;
}

/** @param {NodeJS.ProcessEnv} env */
function claudeSupportsAuthLogin(env) {
  const result = spawnSync("claude", ["auth", "login", "--help"], { env, encoding: "utf8", timeout: 10_000 });
  return result.status === 0 && /--claudeai/.test(result.stdout ?? "");
}

/**
 * Start (or reuse) a detached tmux session running the provider CLI with the
 * per-account config dir env var set, so attaching and completing the login
 * authenticates that isolated account. The CLI process is followed by a
 * message + sleep tail so a failed login stays inspectable instead of the
 * session vanishing.
 *
 * @param {{ provider: AccountProvider; label: string; configDir: string; env?: NodeJS.ProcessEnv }} input
 * @returns {{ ok: boolean; sessionName: string; attachCmd: string; loginCmd: string; reused: boolean; error?: string }}
 */
export function startTmuxLoginSession(input) {
  const env = input.env ?? process.env;
  const bin = SUBSCRIPTION_LOGIN_BIN[input.provider];
  const envVar = SUBSCRIPTION_DIR_ENV_VAR[input.provider];
  const sessionName = loginSessionName(input.label);
  const attachCmd = `tmux attach -t ${sessionName}`;
  if (!bin || !envVar) {
    return {
      ok: false,
      sessionName,
      attachCmd,
      loginCmd: "",
      reused: false,
      error: `provider ${input.provider} has no CLI login`,
    };
  }
  const args = resolveLoginArgs(input.provider, input.configDir, env);
  const loginCmd = `${envVar}=${input.configDir} ${bin}${args.length ? " " + args.join(" ") : ""}`;
  mkdirSync(input.configDir, { recursive: true });
  const has = spawnSync("tmux", ["has-session", "-t", sessionName], { env, encoding: "utf8" });
  if (has.status === 0) {
    return { ok: true, sessionName, attachCmd, loginCmd, reused: true };
  }
  const script = [
    // A stray ANTHROPIC_API_KEY would make `claude` bill the API (or skip the
    // subscription login entirely); the whole point here is subscription auth.
    ...(input.provider === "claude-code" ? ["unset ANTHROPIC_API_KEY"] : []),
    `${envVar}=${shellQuote(input.configDir)} ${bin}${args.length ? " " + args.map(shellQuote).join(" ") : ""}`,
    `status=$?`,
    `printf '\\n[smithers] %s exited with status %s. Detach with Ctrl-b d; close with: tmux kill-session -t %s\\n' ${shellQuote(bin)} "$status" ${shellQuote(sessionName)}`,
    `exec sleep 86400`,
  ].join("; ");
  const result = spawnSync(
    "tmux",
    ["new-session", "-d", "-s", sessionName, "-x", "220", "-y", "50", "sh", "-c", script],
    {
      env,
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    return {
      ok: false,
      sessionName,
      attachCmd,
      loginCmd,
      reused: false,
      error: result.stderr?.trim() || `tmux new-session exited with ${result.status}`,
    };
  }
  return { ok: true, sessionName, attachCmd, loginCmd, reused: false };
}

// An OAuth URL that a provider CLI wants the user to open, as opposed to a
// docs or status link it may also print.
const LOGIN_URL_HINT = /(oauth|authoriz|\/auth|login|device|verify)/i;

/**
 * Scrape the provider CLI's login URL out of the tmux pane.
 *
 * The CLIs print the authorize URL to their own terminal, never to the stdout
 * of the process that spawned them, so a caller that cannot attach to the
 * session (the quota dashboard, an editor, a wizard) otherwise has no way to
 * reach the link. `-J` joins wrapped lines, which matters because these URLs
 * are long enough to wrap even in the 220-column login pane.
 *
 * @param {string} sessionName
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function captureLoginUrl(sessionName, env = process.env) {
  const result = spawnSync("tmux", ["capture-pane", "-p", "-J", "-t", sessionName], { env, encoding: "utf8" });
  if (result.status !== 0) return null;
  const urls = (result.stdout ?? "").match(/https:\/\/[^\s"'<>)\]]+/g);
  if (!urls || urls.length === 0) return null;
  return urls.find((url) => LOGIN_URL_HINT.test(url)) ?? urls[0];
}

/**
 * Poll the config dir until the provider's credential artifact appears.
 *
 * @param {{ provider: AccountProvider; configDir: string; timeoutMs?: number; pollMs?: number; onPoll?: (elapsedMs: number) => void }} input
 * @returns {Promise<{ ok: boolean; elapsedMs: number }>}
 */
export async function waitForLoginCredentials(input) {
  const timeoutMs = input.timeoutMs ?? 600_000;
  const pollMs = input.pollMs ?? 2_000;
  const startedAt = Date.now();
  // On macOS the Claude token lands in a Keychain item this process may not be
  // able to read, and `.claude.json` gains its `oauthAccount` marker the moment
  // the login completes. The marker is a sound *transition* signal, but it
  // outlives the token it describes, so it counts only when it flips during
  // this wait. Treating a pre-existing marker as success would end the wait
  // instantly and register an account holding no credential at all.
  const markerPath = join(input.configDir, ".claude.json");
  const markerAtStart = input.provider === "claude-code" && claudeStateShowsLogin(markerPath);
  const loginCompleted = () =>
    credentialsPresent(input.provider, input.configDir) ||
    (input.provider === "claude-code" && !markerAtStart && claudeStateShowsLogin(markerPath));
  while (true) {
    if (loginCompleted()) {
      return { ok: true, elapsedMs: Date.now() - startedAt };
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      return { ok: false, elapsedMs };
    }
    input.onPoll?.(elapsedMs);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Name which subscription the new label is logged into, and warn when it is
 * one already registered: a duplicate adds no capacity, it just splits a
 * single rate limit across two chain rungs.
 *
 * @param {AccountProvider} provider
 * @param {string} configDir
 * @param {string} label
 * @param {NodeJS.ProcessEnv} env
 * @param {(message: string) => void} onStatus
 */
function reportAccountIdentity(provider, configDir, label, env, onStatus) {
  const identity = readAccountIdentity(provider, configDir);
  const shown = formatAccountIdentity(identity);
  if (shown) onStatus(`${label} is signed in as ${shown}.`);
  let registered = [];
  try {
    registered = listAccounts(env);
  } catch {
    return;
  }
  const duplicates = findDuplicateAccounts(identity, provider, registered, label);
  if (duplicates.length > 0) {
    onStatus(
      `⚠ ${label} is the SAME subscription as ${duplicates.join(", ")} — it shares one rate limit, so it adds no capacity. To use a different subscription: \`smithers agents remove ${label}\`, delete ${configDir}, and re-run the add signed into another account.`,
    );
  }
}

/**
 * Full tmux-assisted registration: start the login session, wait for the
 * credential artifact, then register the account. Emits progress through
 * `onStatus` (plain strings — both the flag path and the wizard render them).
 *
 * @param {import("./runAgentAdd.js").RunAgentAddInput & { timeoutMs?: number; onStatus?: (message: string) => void; onLoginUrl?: (url: string) => void }} input
 * @returns {Promise<ReturnType<typeof runAgentAdd> | { ok: false; reason: string; detail: string; configDir?: string }>}
 */
export async function runAgentAddWithTmuxLogin(input) {
  const env = input.env ?? process.env;
  const onStatus = input.onStatus ?? (() => {});
  if (SUBSCRIPTION_LOGIN_BIN[input.provider] == null) {
    return {
      ok: false,
      reason: "not-a-subscription-provider",
      detail: `--tmux only applies to subscription providers (${input.provider} uses an API key).`,
    };
  }
  if (!tmuxAvailable(env)) {
    return {
      ok: false,
      reason: "tmux-missing",
      detail:
        "tmux is not installed (or not on PATH). Install tmux, or run the login command manually and re-run `smithers agents add` without --tmux.",
    };
  }
  const { defaultConfigDir } = await import("@smthrs/accounts");
  const configDir = input.configDir ?? defaultConfigDir(input.label, env);
  if (credentialsPresent(input.provider, configDir)) {
    onStatus(`Credentials already present in ${configDir}; registering.`);
    return runAgentAdd({ ...input, configDir, env });
  }
  const session = startTmuxLoginSession({ provider: input.provider, label: input.label, configDir, env });
  if (!session.ok) {
    return {
      ok: false,
      reason: "tmux-session-failed",
      detail: session.error ?? "could not start tmux session",
      configDir,
    };
  }
  onStatus(
    session.reused
      ? `Reusing login session ${session.sessionName}.`
      : `Started login session ${session.sessionName} running: ${session.loginCmd}`,
  );
  onStatus(`Attach to finish the browser login:\n\n  ${session.attachCmd}\n`);
  /** @type {string | null} */
  let loginUrl = null;
  const wait = await waitForLoginCredentials({
    provider: input.provider,
    configDir,
    timeoutMs: input.timeoutMs,
    onPoll: (elapsedMs) => {
      // The CLI needs a moment to render its URL, so scrape the pane until one
      // appears rather than only once at startup.
      if (!loginUrl) {
        loginUrl = captureLoginUrl(session.sessionName, env);
        if (loginUrl) {
          onStatus(`Open this URL to finish the login:\n\n  ${loginUrl}\n`);
          input.onLoginUrl?.(loginUrl);
        }
      }
      // One status line every ~30s so long waits stay visibly alive.
      if (elapsedMs > 0 && Math.floor(elapsedMs / 30_000) !== Math.floor((elapsedMs - 2_000) / 30_000)) {
        onStatus(`Waiting for login… (${Math.round(elapsedMs / 1000)}s; attach with: ${session.attachCmd})`);
      }
    },
  });
  if (!wait.ok) {
    return {
      ok: false,
      reason: "login-timeout",
      detail: `No credentials appeared in ${configDir} after ${Math.round(wait.elapsedMs / 1000)}s. The tmux session is still running — attach with \`${session.attachCmd}\`, finish the login, then re-run this command (it will detect the credentials and register).`,
      configDir,
    };
  }
  onStatus(`Login detected after ${Math.round(wait.elapsedMs / 1000)}s; registering ${input.label}.`);
  const result = runAgentAdd({ ...input, configDir, env });
  if (result.ok) {
    reportAccountIdentity(input.provider, configDir, input.label, env, onStatus);
    onStatus(
      `Session ${session.sessionName} left running for inspection. Close it with: tmux kill-session -t ${session.sessionName}`,
    );
  }
  return result;
}

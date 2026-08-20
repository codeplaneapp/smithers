/**
 * Account management actions behind the dashboard buttons: add a seat (spawns
 * the provider CLI's browser login in a detached tmux session via `smithers
 * agents add --tmux`), re-login an existing seat, and remove a seat. Long-lived
 * logins run as background jobs the page polls.
 */

import { runSmithers } from "./usage";

export type AccountJob = {
  id: number;
  kind: "add" | "login" | "refresh";
  provider: string;
  label: string;
  /** Interleaved stdout/stderr lines from the CLI, oldest first. */
  lines: string[];
  /** `tmux attach -t <session>` once the login session is up. */
  attachCmd: string | null;
  /** The provider's OAuth URL, opened in the default browser once seen. */
  loginUrl: string | null;
  /** Set when the CLI finished without ever needing a login. */
  note: string | null;
  done: boolean;
  ok: boolean | null;
  /** Epoch ms the CLI exited, so the page can show the outcome briefly. */
  finishedAt: number | null;
};

/**
 * Hand a URL to the desktop's default browser. The dashboard is a GUI, so a
 * login the user started by clicking a button should land in their browser
 * rather than only being printed somewhere they have to go find.
 */
function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // Leaving the URL on the job is enough for the page to render it.
  }
}

const jobs: AccountJob[] = [];
let nextJobId = 1;

/** Providers the dashboard can add via a subscription browser login. */
const LOGIN_PROVIDERS = new Set(["claude-code", "codex", "kimi", "antigravity"]);

function labelPrefix(provider: string): string {
  return provider === "claude-code" ? "claude" : provider;
}

type RegisteredAccount = {
  label?: string;
  provider?: string;
  configDir?: string;
};

function listRegisteredAccounts(): RegisteredAccount[] {
  const res = runSmithers(["agents", "list", "--format", "json"]);
  if (!res.ok) return [];
  try {
    const parsed = JSON.parse(res.stdout);
    return parsed?.accounts ?? parsed?.data?.accounts ?? [];
  } catch {
    return [];
  }
}

/** claude-1..claude-7 registered → claude-8. */
export function nextFreeLabel(provider: string): string {
  const prefix = labelPrefix(provider);
  const taken = new Set(listRegisteredAccounts().map((account) => account.label ?? ""));
  let n = 1;
  while (taken.has(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

/**
 * Spawn a CLI job and stream its output onto the job record.
 *
 * @param argv the full `smithers` argument vector
 */
function spawnCliJob(kind: AccountJob["kind"], provider: string, label: string, argv: string[]): AccountJob {
  const job: AccountJob = {
    id: nextJobId++,
    kind,
    provider,
    label,
    lines: [],
    attachCmd: null,
    loginUrl: null,
    note: null,
    done: false,
    ok: null,
    finishedAt: null,
  };
  jobs.push(job);
  const bin = Bun.which("smithers") ?? "smithers";
  const proc = Bun.spawn([bin, ...argv], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const consume = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of stream) {
      buffered += decoder.decode(chunk, { stream: true });
      const parts = buffered.split("\n");
      buffered = parts.pop() ?? "";
      for (const line of parts) {
        const text = line.trimEnd();
        if (!text) continue;
        job.lines.push(text);
        // Stop before a closing paren: the command also appears inside the
        // "(… attach with: …)" progress line, where \S+ would capture the paren
        // and hand the user a command that does not run. First match wins.
        const attach = text.match(/tmux attach -t [^\s)]+/);
        if (attach && !job.attachCmd) job.attachCmd = attach[0];
        const url = text.match(/https:\/\/[^\s"'<>)\]]+/);
        if (url && !job.loginUrl) {
          job.loginUrl = url[0];
          openInBrowser(url[0]);
        }
        if (/already present/i.test(text)) {
          job.note = `${job.label} already holds a valid login, so no browser sign-in was needed.`;
        }
      }
    }
    if (buffered.trim()) job.lines.push(buffered.trim());
  };
  void (async () => {
    await Promise.all([consume(proc.stdout), consume(proc.stderr)]);
    const exitCode = await proc.exited;
    job.done = true;
    job.ok = exitCode === 0;
    job.finishedAt = Date.now();
  })();
  return job;
}

function addArgv(provider: string, label: string, extra: string[]): string[] {
  return ["agents", "add", "--provider", provider, "--label", label, "--tmux", ...extra];
}

/** Registers a brand-new seat under the next free label for the provider. */
export function startAddAccount(provider: string): AccountJob | { error: string } {
  if (!LOGIN_PROVIDERS.has(provider)) return { error: `Cannot add provider "${provider}" from the dashboard.` };
  const label = nextFreeLabel(provider);
  return spawnCliJob("add", provider, label, addArgv(provider, label, []));
}

/** Re-runs the browser login for an existing seat, keeping its config dir. */
export function startRelogin(label: string): AccountJob | { error: string } {
  const account = listRegisteredAccounts().find((entry) => entry.label === label);
  if (!account?.provider) return { error: `Unknown account "${label}".` };
  if (!LOGIN_PROVIDERS.has(account.provider)) return { error: `"${label}" is not a subscription-login provider.` };
  const extra = ["--replace", ...(account.configDir ? ["--configDir", account.configDir] : [])];
  return spawnCliJob("login", account.provider, label, addArgv(account.provider, label, extra));
}

/**
 * Refresh a lapsed Claude token without a browser. `agents reauth` spends one
 * minimal request so Claude Code exchanges its stored refresh token, and only
 * escalates to a browser sign-in when that genuinely fails.
 */
export function startRefresh(label: string): AccountJob | { error: string } {
  const account = listRegisteredAccounts().find((entry) => entry.label === label);
  if (!account?.provider) return { error: `Unknown account "${label}".` };
  if (account.provider !== "claude-code") {
    return { error: `"${label}" has no token refresh; sign in again instead.` };
  }
  // --refreshOnly: nobody is watching a browser here, and the interactive
  // recovery path clears the stored credential before prompting.
  return spawnCliJob("refresh", account.provider, label, ["agents", "reauth", "--label", label, "--refresh-only"]);
}

/** An expired token is refreshable; a missing one needs a browser sign-in. */
const REFRESHABLE_ERROR = /expired/i;

// Auto-refresh is a side effect of rendering, so it must not retry in a tight
// loop when a token cannot be recovered.
const AUTO_REFRESH_COOLDOWN_MS = 10 * 60 * 1000;
const lastAutoRefresh = new Map<string, number>();

/**
 * Start a background refresh for every seat whose token has simply lapsed.
 *
 * The dashboard used to render the provider's own advice ("run `claude` to
 * refresh") and leave the user to do it by hand, even though the token needs no
 * human input to recover.
 */
export function autoRefreshExpired(snapshot: {
  groups?: { seats?: { label: string; provider: string; error: string | null }[] }[];
}): void {
  const now = Date.now();
  for (const group of snapshot.groups ?? []) {
    for (const seat of group.seats ?? []) {
      if (seat.provider !== "claude-code") continue;
      if (!seat.error || !REFRESHABLE_ERROR.test(seat.error)) continue;
      if (jobs.some((job) => job.label === seat.label && !job.done)) continue;
      if (now - (lastAutoRefresh.get(seat.label) ?? 0) < AUTO_REFRESH_COOLDOWN_MS) continue;
      lastAutoRefresh.set(seat.label, now);
      startRefresh(seat.label);
    }
  }
}

export function removeAccount(label: string): { ok: boolean; detail: string } {
  const res = runSmithers(["agents", "remove", label]);
  return {
    ok: res.ok,
    detail: res.ok ? `Removed ${label}.` : res.stderr.trim() || res.stdout.trim(),
  };
}

/** Recent jobs, newest last; the page polls this while a login is pending. */
export function listJobs(): AccountJob[] {
  return jobs.slice(-8);
}

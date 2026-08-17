/**
 * Account management actions behind the dashboard buttons: add a seat (spawns
 * the provider CLI's browser login in a detached tmux session via `smithers
 * agents add --tmux`), re-login an existing seat, and remove a seat. Long-lived
 * logins run as background jobs the page polls.
 */

import { runSmithers } from "./usage";

export type AccountJob = {
  id: number;
  kind: "add" | "login";
  provider: string;
  label: string;
  /** Interleaved stdout/stderr lines from the CLI, oldest first. */
  lines: string[];
  /** `tmux attach -t <session>` once the login session is up. */
  attachCmd: string | null;
  done: boolean;
  ok: boolean | null;
};

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

function spawnJob(kind: AccountJob["kind"], provider: string, label: string, extraArgs: string[]): AccountJob {
  const job: AccountJob = {
    id: nextJobId++,
    kind,
    provider,
    label,
    lines: [],
    attachCmd: null,
    done: false,
    ok: null,
  };
  jobs.push(job);
  const bin = Bun.which("smithers") ?? "smithers";
  const proc = Bun.spawn([bin, "agents", "add", "--provider", provider, "--label", label, "--tmux", ...extraArgs], {
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
        const attach = text.match(/tmux attach -t \S+/);
        if (attach) job.attachCmd = attach[0];
      }
    }
    if (buffered.trim()) job.lines.push(buffered.trim());
  };
  void (async () => {
    await Promise.all([consume(proc.stdout), consume(proc.stderr)]);
    const exitCode = await proc.exited;
    job.done = true;
    job.ok = exitCode === 0;
  })();
  return job;
}

/** Registers a brand-new seat under the next free label for the provider. */
export function startAddAccount(provider: string): AccountJob | { error: string } {
  if (!LOGIN_PROVIDERS.has(provider)) return { error: `Cannot add provider "${provider}" from the dashboard.` };
  return spawnJob("add", provider, nextFreeLabel(provider), []);
}

/** Re-runs the browser login for an existing seat, keeping its config dir. */
export function startRelogin(label: string): AccountJob | { error: string } {
  const account = listRegisteredAccounts().find((entry) => entry.label === label);
  if (!account?.provider) return { error: `Unknown account "${label}".` };
  if (!LOGIN_PROVIDERS.has(account.provider)) return { error: `"${label}" is not a subscription-login provider.` };
  const extra = ["--replace", ...(account.configDir ? ["--configDir", account.configDir] : [])];
  return spawnJob("login", account.provider, label, extra);
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

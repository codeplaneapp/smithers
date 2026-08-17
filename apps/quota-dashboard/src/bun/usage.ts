/**
 * Read subscription quota for every registered account.
 *
 * Source of truth is `smithers usage --format json`, not the accounts registry:
 * the registry knows which accounts exist, but only the usage command resolves
 * live per-window consumption from each provider's OAuth session.
 */

import { classifyAccountAvailability } from "@smthrs/usage/classifyAccountAvailability";

export type UsageWindow = {
  id: string;
  label: string;
  unit: string;
  usedPercent: number;
  resetsAt: string | null;
  /** Model family this window caps (e.g. "fable"); unset for account-wide windows. */
  modelScope?: string;
};

export type SeatAvailability = {
  /**
   * blocked — an account-wide window is exhausted; the seat serves nothing.
   * degraded — only a model-scoped cap (e.g. Fable weekly) is exhausted.
   * ok — headroom everywhere. unknown — no windows to judge.
   */
  status: "ok" | "degraded" | "blocked" | "unknown";
  reasons: string[];
};

export type UsageReport = {
  accountLabel: string;
  provider: string;
  authMode?: string;
  windows: UsageWindow[];
  planType?: string | null;
  fetchedAt?: string;
  stale?: boolean;
  estimate?: boolean;
  error?: string | null;
};

export type Seat = {
  label: string;
  provider: string;
  /** Subscription the seat is signed into, when the registry knows it. */
  account: string | null;
  planType: string | null;
  weekly: UsageWindow | null;
  session: UsageWindow | null;
  /** Model-scoped weekly windows (e.g. the separate Fable cap), if reported. */
  scoped: UsageWindow[];
  /** Any remaining windows the fixed rows above do not cover. */
  extra: UsageWindow[];
  availability: SeatAvailability;
  /** Set when the seat cannot report — expired token, missing credentials. */
  error: string | null;
};

export type ProviderGroup = {
  provider: string;
  /** Display name, e.g. "Claude Code". */
  title: string;
  /** True when the dashboard can start a browser login for this provider. */
  canLogin: boolean;
  seats: Seat[];
};

export type Snapshot = {
  fetchedAt: string;
  groups: ProviderGroup[];
  error: string | null;
};

/**
 * Every registered provider gets a section. Order is deliberate (the pool's
 * primary seats first); providers absent from this list still render, appended
 * in the order the usage report returns them, so a newly supported provider
 * charts itself with no change here.
 */
const PROVIDER_ORDER = ["claude-code", "codex", "kimi", "antigravity", "anthropic-api", "openai-api", "gemini-api"];

const PROVIDER_TITLES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  kimi: "Kimi",
  antigravity: "Antigravity",
  "anthropic-api": "Anthropic API",
  "openai-api": "OpenAI API",
  "gemini-api": "Gemini API",
};

/** Providers whose seats are created by a browser login the dashboard can drive. */
const LOGIN_PROVIDERS = new Set(["claude-code", "codex", "kimi", "antigravity"]);

export function runSmithers(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const bin = Bun.which("smithers") ?? "smithers";
  const proc = Bun.spawnSync([bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    // The CLI resolves the account registry from SMITHERS_HOME/$HOME; inherit it.
    env: process.env,
  });
  return {
    ok: proc.exitCode === 0,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/**
 * Map account label -> signed-in subscription, e.g. claude-3 -> a@b.com.
 *
 * `usage` reports quota but not identity, and identity is what makes the
 * dashboard actionable: "claude-3 is at 90%" is only useful if you know which
 * subscription to go top up or re-authenticate.
 */
function readAccountIdentities(): Map<string, string> {
  const identities = new Map<string, string>();
  const res = runSmithers(["agents", "list", "--format", "json"]);
  if (!res.ok) return identities;
  try {
    const parsed = JSON.parse(res.stdout);
    const accounts = parsed?.accounts ?? parsed?.data?.accounts ?? [];
    for (const account of accounts) {
      const who = account?.signedInAs ?? account?.account ?? account?.email ?? null;
      if (account?.label && who) identities.set(account.label, String(who));
    }
  } catch {
    // Identity is a nicety; quota still renders without it.
  }
  return identities;
}

const pickWindow = (windows: UsageWindow[], match: (id: string) => boolean) =>
  windows.find((w) => match((w.id ?? "").toLowerCase()) || match((w.label ?? "").toLowerCase())) ?? null;

export function readSnapshot(): Snapshot {
  const fetchedAt = new Date().toISOString();
  const res = runSmithers(["usage", "--format", "json"]);
  if (!res.ok && !res.stdout.trim()) {
    return {
      fetchedAt,
      groups: [],
      error: res.stderr.trim() || "smithers usage failed and produced no output",
    };
  }

  let reports: UsageReport[];
  try {
    const parsed = JSON.parse(res.stdout);
    reports = parsed?.reports ?? parsed?.data?.reports ?? [];
  } catch (err) {
    return {
      fetchedAt,
      groups: [],
      error: `could not parse smithers usage output: ${(err as Error).message}`,
    };
  }

  const identities = readAccountIdentities();
  const byProvider = new Map<string, Seat[]>();

  for (const report of reports) {
    const windows = report.windows ?? [];
    const weekly = pickWindow(
      windows.filter((w) => !w.modelScope),
      (s) => s.includes("week"),
    );
    const session = pickWindow(windows, (s) => s.includes("hour") || s.includes("session"));
    const scoped = windows.filter((w) => w.modelScope);
    const seat: Seat = {
      label: report.accountLabel,
      provider: report.provider,
      account: identities.get(report.accountLabel) ?? null,
      planType: report.planType ?? null,
      weekly,
      session,
      scoped,
      extra: windows.filter((w) => w !== weekly && w !== session && !w.modelScope),
      availability: report.error
        ? { status: "unknown", reasons: [] }
        : classifyAccountAvailability(
            windows.map((w) => ({
              ...w,
              unit: w.unit as "percent" | "count" | "estimated",
              resetsAt: w.resetsAt ?? undefined,
            })),
          ),
      error: report.error ?? null,
    };
    const seats = byProvider.get(report.provider);
    if (seats) seats.push(seat);
    else byProvider.set(report.provider, [seat]);
  }

  // Most headroom first: the dashboard exists to answer "which seat do I have
  // room on right now", and a seat that cannot report is the most urgent of all.
  const byHeadroom = (a: Seat, b: Seat) => {
    if (!!a.error !== !!b.error) return a.error ? -1 : 1;
    return (a.weekly?.usedPercent ?? 0) - (b.weekly?.usedPercent ?? 0);
  };
  const groups: ProviderGroup[] = [...byProvider.entries()]
    .sort(([a], [b]) => {
      const ai = PROVIDER_ORDER.indexOf(a);
      const bi = PROVIDER_ORDER.indexOf(b);
      return (ai === -1 ? PROVIDER_ORDER.length : ai) - (bi === -1 ? PROVIDER_ORDER.length : bi);
    })
    .map(([provider, seats]) => ({
      provider,
      title: PROVIDER_TITLES[provider] ?? provider,
      canLogin: LOGIN_PROVIDERS.has(provider),
      seats: seats.sort(byHeadroom),
    }));

  return { fetchedAt, groups, error: null };
}

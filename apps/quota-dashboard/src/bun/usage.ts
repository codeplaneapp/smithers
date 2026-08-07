/**
 * Read subscription quota for every registered account.
 *
 * Source of truth is `smithers usage --format json`, not the accounts registry:
 * the registry knows which accounts exist, but only the usage command resolves
 * live per-window consumption from each provider's OAuth session.
 */

export type UsageWindow = {
  id: string;
  label: string;
  unit: string;
  usedPercent: number;
  resetsAt: string | null;
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
  provider: "claude-code" | "codex";
  /** Subscription the seat is signed into, when the registry knows it. */
  account: string | null;
  planType: string | null;
  weekly: UsageWindow | null;
  session: UsageWindow | null;
  /** Set when the seat cannot report — expired token, missing credentials. */
  error: string | null;
};

export type Snapshot = {
  fetchedAt: string;
  claude: Seat[];
  codex: Seat[];
  /** Providers present in the registry that this dashboard does not chart. */
  otherProviders: { label: string; provider: string; error: string | null }[];
  error: string | null;
};

/** Providers this dashboard charts. Everything else is listed, not charted. */
const CHARTED = new Set(["claude-code", "codex"]);

function runSmithers(args: string[]): { ok: boolean; stdout: string; stderr: string } {
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
      claude: [],
      codex: [],
      otherProviders: [],
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
      claude: [],
      codex: [],
      otherProviders: [],
      error: `could not parse smithers usage output: ${(err as Error).message}`,
    };
  }

  const identities = readAccountIdentities();
  const claude: Seat[] = [];
  const codex: Seat[] = [];
  const otherProviders: Snapshot["otherProviders"] = [];

  for (const report of reports) {
    if (!CHARTED.has(report.provider)) {
      otherProviders.push({
        label: report.accountLabel,
        provider: report.provider,
        error: report.error ?? null,
      });
      continue;
    }
    const windows = report.windows ?? [];
    const seat: Seat = {
      label: report.accountLabel,
      provider: report.provider as Seat["provider"],
      account: identities.get(report.accountLabel) ?? null,
      planType: report.planType ?? null,
      weekly: pickWindow(windows, (s) => s.includes("week")),
      session: pickWindow(windows, (s) => s.includes("hour") || s.includes("session")),
      error: report.error ?? null,
    };
    (report.provider === "codex" ? codex : claude).push(seat);
  }

  // Most headroom first: the dashboard exists to answer "which seat do I have
  // room on right now", and a seat that cannot report is the most urgent of all.
  const byHeadroom = (a: Seat, b: Seat) => {
    if (!!a.error !== !!b.error) return a.error ? -1 : 1;
    return (a.weekly?.usedPercent ?? 0) - (b.weekly?.usedPercent ?? 0);
  };
  claude.sort(byHeadroom);
  codex.sort(byHeadroom);

  return { fetchedAt, claude, codex, otherProviders, error: null };
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Account load balancing for multi-account campaigns.
 *
 * Smithers already ships the registry (`~/.smithers/accounts.json`), the
 * account→env mapping, and per-account usage probes. What it does not ship is a
 * SELECTION policy, which is what this module is: given a role, return the
 * registered accounts ordered best-first.
 *
 * Selection returns an ORDER, not a winner. Callers feed the ordered list into
 * `agent={[primary, ...fallbacks]}`, so a stale snapshot or a mid-run quota
 * death advances to the next account instead of parking the run — the failure
 * that repeatedly killed multi-hour rounds when every seat was one account.
 */

export type UsageWindow = {
  id: string;
  label?: string;
  unit?: string;
  usedPercent?: number;
  resetsAt?: string;
};

export type AccountUsage = {
  label: string;
  provider: string;
  configDir?: string;
  model?: string;
  windows: UsageWindow[];
  /** Set when the probe failed; such accounts stay usable but sort last. */
  error?: string | null;
  fetchedAt?: string;
};

export type UsageSnapshot = {
  fetchedAt: string;
  accounts: AccountUsage[];
};

/** Where the refresh task writes, and render reads. */
export const SNAPSHOT_PATH = join(homedir(), ".smithers", "account-usage.json");

export function writeSnapshot(snapshot: UsageSnapshot, path = SNAPSHOT_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(snapshot, null, 2));
}

/**
 * Read the snapshot synchronously. Render is synchronous and must never block
 * on the network, so the probe runs in a compute Task and render reads its
 * output. A missing snapshot is not an error: selection degrades to registry
 * order, and the campaign still runs on the ambient login.
 */
export function readSnapshot(path = SNAPSHOT_PATH): UsageSnapshot | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as UsageSnapshot;
  } catch {
    return null;
  }
}

const pct = (u: AccountUsage, id: string): number | undefined =>
  u.windows.find((w) => w.id === id)?.usedPercent;

/** Percent used in a window whose id contains `needle`, if one is published. */
const pctLike = (u: AccountUsage, needle: string): number | undefined =>
  u.windows.find((w) => w.id.toLowerCase().includes(needle))?.usedPercent;

/** The rolling session window: the one that actually stops work right now. */
export const sessionUsed = (u: AccountUsage): number => pct(u, "5h") ?? 0;

/**
 * Fable headroom for an account, 0–100.
 *
 * The subscription usage endpoint publishes per-model weekly windows
 * (`seven_day_opus`, `seven_day_sonnet`, and a Fable equivalent as tiers land).
 * When no Fable-specific window exists we fall back to the overall weekly
 * figure, which is the conservative proxy: it is the pool Fable draws from
 * either way.
 */
export const fableHeadroom = (u: AccountUsage): number =>
  100 - (pctLike(u, "fable") ?? pct(u, "weekly") ?? 0);

export const opusHeadroom = (u: AccountUsage): number =>
  100 - (pctLike(u, "opus") ?? pct(u, "weekly") ?? 0);

/** An account with no session capacity cannot take work at all right now. */
const EXHAUSTED_SESSION = 98;

export type ClaudeRole = "fable" | "opus" | "other";

/**
 * Fable is the scarce tier, so the default policy CONSERVES it:
 *   - a Fable task takes the account with the MOST Fable headroom;
 *   - an Opus task takes the account with the LEAST Fable headroom that still
 *     has Opus and session capacity, keeping Fable-rich accounts available for
 *     work only Fable can do.
 *
 * Set this to false to make Opus prefer the healthiest account instead. That is
 * the entire switch, deliberately one constant.
 */
export const CONSERVE_FABLE = true;

export function orderClaudeAccounts(
  accounts: AccountUsage[],
  role: ClaudeRole,
): AccountUsage[] {
  const claude = accounts.filter((a) => a.provider === "claude-code");
  const usable = claude.filter((a) => sessionUsed(a) < EXHAUSTED_SESSION);
  const spent = claude.filter((a) => sessionUsed(a) >= EXHAUSTED_SESSION);

  const scored = [...usable].sort((a, b) => {
    if (role === "fable") {
      const d = fableHeadroom(b) - fableHeadroom(a); // most Fable first
      if (d !== 0) return d;
    } else if (role === "opus" && CONSERVE_FABLE) {
      // Least Fable headroom first — but an Opus-exhausted account is no use
      // for an Opus task however much Fable it has left, so that dominates.
      const oa = opusHeadroom(a);
      const ob = opusHeadroom(b);
      if (oa <= 2 || ob <= 2) {
        const d = ob - oa;
        if (d !== 0) return d;
      }
      const d = fableHeadroom(a) - fableHeadroom(b);
      if (d !== 0) return d;
    } else {
      const d = opusHeadroom(b) - opusHeadroom(a);
      if (d !== 0) return d;
    }
    // Tie-break on the session window so load spreads rather than stacking.
    const s = sessionUsed(a) - sessionUsed(b);
    if (s !== 0) return s;
    return a.label.localeCompare(b.label);
  });

  // Exhausted accounts stay in the chain, last: a window reset during a long
  // run makes them viable again, and an empty chain is worse than a tail entry.
  return [...scored, ...spent];
}

/** Codex has no tier scarcity: spread by session use, then weekly. */
export function orderCodexAccounts(accounts: AccountUsage[]): AccountUsage[] {
  return accounts
    .filter((a) => a.provider === "codex")
    .sort((a, b) => {
      const s = sessionUsed(a) - sessionUsed(b);
      if (s !== 0) return s;
      const w = (pct(a, "weekly") ?? 0) - (pct(b, "weekly") ?? 0);
      if (w !== 0) return w;
      return a.label.localeCompare(b.label);
    });
}

/**
 * A stable per-lane rotation offset.
 *
 * Lanes rendering in the same frame see the same snapshot and would otherwise
 * all pick the same "best" account and collide on its session window. Rotating
 * by a lane-derived offset spreads them deterministically — stable across
 * resume, unlike a counter or a random pick.
 */
export function rotate<T>(items: T[], key: string): T[] {
  if (items.length <= 1) return items;
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const n = h % items.length;
  return [...items.slice(n), ...items.slice(0, n)];
}

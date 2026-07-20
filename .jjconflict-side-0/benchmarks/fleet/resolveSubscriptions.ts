import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Subscription } from "./Subscription";
import { readFleetSubscriptions } from "./readFleetSubscriptions";

/**
 * Enumerate the Claude subscriptions the fleet runs on, one per rollout
 * container. Prefers the fleet manifest written by `fleet login`
 * (`$SMITHERS_HOME/.smithers/fleet/subscriptions.json`); falls back to any
 * `claude-code` accounts in `~/.smithers/accounts.json`.
 *
 * Usage windows are not read here; the launcher can enrich each `Subscription`
 * with `usage` (from `smithers usage`) before calling `planShards`, which
 * weights the shard split by remaining headroom. With no usage attached the
 * plan is an even round-robin.
 */
export function resolveSubscriptions(): Subscription[] {
  const fleet = readFleetSubscriptions();
  if (fleet.length > 0) {
    return fleet.map((f) => ({ id: f.id, label: f.label, configDir: f.configDir }));
  }
  const root = process.env.SMITHERS_HOME?.trim() || join(homedir(), ".smithers");
  const path = join(root, "accounts.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const accounts = extractAccounts(parsed);
  return accounts
    .filter((a) => a.provider === "claude-code")
    .map((a) => ({
      id: a.label,
      label: a.label,
      configDir: a.configDir,
    }));
}

type RawAccount = { label: string; provider: string; configDir?: string };

function extractAccounts(parsed: unknown): RawAccount[] {
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { accounts?: unknown }).accounts)
      ? (parsed as { accounts: unknown[] }).accounts
      : [];
  return list.filter(
    (a): a is RawAccount =>
      !!a && typeof a === "object" && typeof (a as RawAccount).label === "string" && typeof (a as RawAccount).provider === "string",
  );
}

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SliceDef } from "./ferricConfig";

/**
 * The durable landing ledger: the campaign's source of truth for what has
 * actually landed and whether the queue is halted.
 *
 * Written ONLY by the land task (sole-writer invariant), read everywhere. It
 * lives on disk rather than in run state so an operator restart, a fresh
 * milestone run, or a hand inspection all see the same frontier.
 */
export type FerricLedger = {
  passingCount: number;
  totalCount: number;
  landed: string[];
  haltEpoch: number;
  halted: boolean;
};

const EMPTY: FerricLedger = {
  passingCount: 0,
  totalCount: 0,
  landed: [],
  haltEpoch: 0,
  halted: false,
};

export function readLedger(repo: string): FerricLedger {
  const p = join(repo, "ferric-ledger.json");
  if (!existsSync(p)) return { ...EMPTY };
  try {
    return { ...EMPTY, ...JSON.parse(readFileSync(p, "utf8")) };
  } catch {
    // An unreadable ledger is not an empty ledger: halt rather than re-land.
    return { ...EMPTY, halted: true };
  }
}

export function writeLedger(repo: string, ledger: FerricLedger): void {
  writeFileSync(join(repo, "ferric-ledger.json"), JSON.stringify(ledger, null, 2));
}

export type Frontier = {
  ledger: FerricLedger;
  landed: SliceDef[];
  blocked: SliceDef[];
  total: number;
  done: boolean;
};

/**
 * What a milestone gate needs to know: progress, and which lanes gave up.
 *
 * Blocked slices are evidence presented AT the gate, not a crash before it — an
 * audited failure mode was lane exhaustion crashing past the very kill gate that
 * existed to judge it.
 */
export function frontier(ctx: any, repo: string, slices: SliceDef[], outputs: any): Frontier {
  const ledger = readLedger(repo);
  const landed = slices.filter((s) => ledger.landed.includes(s.id));
  const blocked = slices.filter((s) => {
    if (ledger.landed.includes(s.id)) return false;
    const rounds = ctx.iterationCount(outputs.frcVerify, `${s.id}:verify`);
    const v = ctx.latest(outputs.frcVerify, `${s.id}:verify`);
    return rounds >= 4 && v?.ok !== true;
  });
  return {
    ledger,
    landed,
    blocked,
    total: slices.length,
    done: landed.length === slices.length && slices.length > 0,
  };
}

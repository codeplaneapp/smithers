import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Append-only execution ledger shared by the fixtures.
 *
 * A fixture body appends one line per body execution. The suite folds the
 * ledger into the observation, which is how at-least-once execution becomes
 * visible: a node whose output committed before a crash must not appear
 * twice, and a node interrupted mid-flight must.
 */

export const LEDGER_FILE = "executions.log";

export function recordExecution(scratchDir: string, entry: string): void {
  appendFileSync(join(scratchDir, LEDGER_FILE), `${entry}\n`);
}

export function readLedger(scratchDir: string): string[] {
  const path = join(scratchDir, LEDGER_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function ledgerSideEffects(scratchDir: string): Record<string, unknown> {
  return { executions: readLedger(scratchDir) };
}

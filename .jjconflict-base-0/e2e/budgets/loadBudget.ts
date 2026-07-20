import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Reads a JSON budget file from `e2e/budgets/`. Tests use the returned values
 * to enforce ceilings (e.g. RSS during a 10-minute live stream); a regression
 * must fail the test, not silently widen the budget.
 *
 * Update the JSON files — not callers — when a budget legitimately changes.
 */
export async function loadBudget(
  name: "memory" | "latency",
): Promise<Record<string, unknown>> {
  const path = resolve(HERE, `${name}.json`);
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

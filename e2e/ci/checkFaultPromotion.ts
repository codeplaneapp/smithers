import {
  assertMatrixInventory,
  loadMatrix,
  loadMatrixFromGit,
  promotionFailures,
  readHistory,
} from "./faultMatrix.ts";

const matrix = loadMatrix();
assertMatrixInventory(matrix);
const refIndex = process.argv.indexOf("--base-ref");
const baseRef = refIndex >= 0 ? process.argv[refIndex + 1] : undefined;

if (!baseRef) {
  console.log(`[fault-promotion] matrix valid; gate requires ${matrix.promotionPassesRequired} clean runs`);
  process.exit(0);
}

const historyPath = process.env.SMITHERS_E2E_FLAKE_HISTORY;
if (!historyPath) throw new Error("SMITHERS_E2E_FLAKE_HISTORY is required with --base-ref");
const base = loadMatrixFromGit(baseRef);
if (!base) {
  console.log("[fault-promotion] base branch has no matrix; bootstrapping automated history");
  process.exit(0);
}
const failures = promotionFailures(matrix, base, readHistory(historyPath));
if (failures.length > 0) {
  for (const failure of failures) console.error(`[fault-promotion] ${failure}`);
  process.exit(1);
}
console.log("[fault-promotion] all requested promotions have 100 consecutive complete nightly passes");

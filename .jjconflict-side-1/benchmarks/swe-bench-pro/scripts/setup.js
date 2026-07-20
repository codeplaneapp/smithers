#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { config } from "../src/config.js";

/**
 * Vendor the canonical ScaleAI harness (run scripts, parsers, dockerfiles, and
 * the reference evaluator) so scoring uses ScaleAI's own artifacts verbatim.
 * Idempotent: skips if already present.
 */
function main() {
  if (existsSync(config.harnessDir)) {
    console.log(`[setup] canonical harness already present at ${config.harnessDir}`);
    return;
  }
  mkdirSync(dirname(config.harnessDir), { recursive: true });
  console.log(`[setup] cloning ${config.upstream.harnessRepo} → ${config.harnessDir}`);
  execFileSync("git", ["clone", "--depth", "1", config.upstream.harnessRepo, config.harnessDir], {
    stdio: "inherit",
  });
  console.log("[setup] done. Run `node scripts/fetch-dataset.js` if the dataset JSONL is missing.");
}

main();

#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = process.cwd();

const budgets = [
  {
    path: "packages/engine/src/engine.js",
    maxLines: 7340,
    reason: "engine orchestration core",
  },
  {
    path: "apps/cli/src/index.js",
    maxLines: 5715,
    reason: "CLI command registry",
  },
  {
    path: "packages/server/src/gateway.js",
    maxLines: 4148,
    reason: "Gateway transport and RPC core",
  },
];

let failed = false;

for (const budget of budgets) {
  const text = readFileSync(resolve(repoRoot, budget.path), "utf8");
  const lines = text.split(/\r?\n/).length;
  if (lines > budget.maxLines) {
    failed = true;
    console.error(
      `${budget.path} has ${lines} lines, above the ${budget.maxLines} line budget for ${budget.reason}. Extract new behavior into a focused module instead of growing this file.`,
    );
  }
}

if (failed) {
  process.exit(1);
}

console.log("ok: architecture line budgets respected");

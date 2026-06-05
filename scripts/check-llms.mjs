#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedFiles = [
  "docs/llms.txt",
  "docs/llms-core.txt",
  "docs/llms-memory.txt",
  "docs/llms-openapi.txt",
  "docs/llms-observability.txt",
  "docs/llms-effect.txt",
  "docs/llms-integrations.txt",
  "docs/llms-events.txt",
  "docs/llms-full.txt",
  "skills/smithers/llms-full.txt",
  "apps/cli/docs/llms.txt",
  "apps/cli/docs/llms-full.txt",
];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("bun", ["scripts/generate-llms.ts"]);
run("bun", ["scripts/optimize-llms-full.ts"]);

const status = spawnSync("git", ["status", "--porcelain", "--", ...generatedFiles], {
  cwd: root,
  encoding: "utf8",
});
if (status.status !== 0) {
  process.exit(status.status ?? 1);
}
if (status.stdout.trim()) {
  console.error("Generated llms artifacts are out of date:");
  console.error(status.stdout.trimEnd());
  console.error("\nRun `pnpm docs:llms` and commit the resulting files.");
  process.exit(1);
}

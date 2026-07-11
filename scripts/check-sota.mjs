#!/usr/bin/env node
// CI gate: the SOTA registry's generated surfaces must match the JSON.
// Re-runs the generator and fails when docs/reference/sota-models.mdx or
// apps/cli/src/sota-models.generated.js would change.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedFiles = ["docs/reference/sota-models.mdx", "apps/cli/src/sota-models.generated.js"];

const before = new Map(
  generatedFiles.map((file) => [
    file,
    existsSync(resolve(root, file)) ? readFileSync(resolve(root, file), "utf8") : null,
  ]),
);

const result = spawnSync("bun", ["scripts/generate-sota.ts"], { cwd: root, stdio: "inherit" });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const tests = spawnSync(
  "bun",
  ["test", "scripts/sota.test.ts", "scripts/sota-maintenance-artifact.test.ts"],
  { cwd: root, stdio: "inherit" },
);
if (tests.status !== 0) {
  process.exit(tests.status ?? 1);
}

const changed = generatedFiles.filter((file) => {
  const current = readFileSync(resolve(root, file), "utf8");
  return (before.get(file) ?? null) !== current;
});

if (changed.length) {
  console.error("SOTA registry artifacts are out of date:");
  for (const file of changed) console.error(`  ${file}`);
  console.error("Run `pnpm sota:gen` and commit the results.");
  process.exit(1);
}

console.log("SOTA registry artifacts are up to date.");

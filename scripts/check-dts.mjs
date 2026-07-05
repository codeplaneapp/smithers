#!/usr/bin/env node
// Freshness gate for the per-file declaration bundles (packages that ship one
// `.d.ts` per source module so `pkg/<subpath>` resolves real types). Regenerates
// them from source and fails if the committed output drifted — the type-side
// sibling of check-docs/check-llms. Runs in CI's `pnpm test` gate.
//
// Determinism note: the tsup dts build must pin `format: ["esm"]`, otherwise it
// emits `.d.cts` and this gate reports spurious drift.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = ["packages/graph", "packages/integrations"];

let failed = false;
for (const pkg of packages) {
  const cwd = join(repoRoot, pkg);
  if (!existsSync(join(cwd, "tsup.config.ts"))) {
    console.error(`check-dts: ${pkg} has no tsup.config.ts; skipping`);
    continue;
  }
  process.stdout.write(`check-dts: regenerating declarations for ${pkg}… `);
  try {
    execFileSync("pnpm", ["-C", pkg, "run", "build"], { cwd: repoRoot, stdio: "pipe" });
  } catch (error) {
    console.error(`\ncheck-dts: build failed for ${pkg}\n${error.stdout ?? ""}${error.stderr ?? ""}`);
    failed = true;
    continue;
  }
  // Compare only the declaration files under this package's src.
  const diff = execFileSync(
    "git",
    ["status", "--porcelain", "--", `${pkg}/src`],
    { cwd: repoRoot, encoding: "utf8" },
  ).trim();
  const dtsDrift = diff
    .split("\n")
    .filter((line) => line.trim().length > 0 && /\.d\.(ts|cts|mts)$/.test(line));
  if (dtsDrift.length > 0) {
    console.error("DRIFT");
    console.error(
      `check-dts: committed declarations in ${pkg}/src are stale. Run \`pnpm -C ${pkg} run build\` and commit the result:\n${dtsDrift.join("\n")}`,
    );
    failed = true;
  } else {
    console.log("ok");
  }
}

if (failed) {
  process.exit(1);
}
console.log("check-dts: all per-file declarations are fresh");

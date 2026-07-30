#!/usr/bin/env node
// Cross-platform `oxlint` runner.
//
// The lint scope is every `packages/*/{src,internal,tests}` directory.
// We resolve that list here in JS rather than via a shell glob: cmd.exe and
// PowerShell do not expand `packages/*/src` the way bash does, and oxlint does
// not expand globs in its path arguments either — so on Windows the old
// `oxlint ... packages/*/src packages/*/tests` script received the patterns
// literally, matched nothing, and exited 1 ("No files found to lint"). Doing
// the expansion in Node makes `pnpm lint` behave identically on every OS and
// shell. oxlint is invoked through its JS launcher via `node` to avoid the
// `.cmd`/`.exe` bin-shim resolution differences across platforms.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const oxlintBin = join(dirname(require.resolve("oxlint/package.json")), "bin", "oxlint");

const packagesDir = join(root, "packages");
const targets = [];
for (const name of readdirSync(packagesDir).sort()) {
  for (const sub of ["src", "internal", "tests"]) {
    if (existsSync(join(packagesDir, name, sub))) {
      // Forward-slash relative paths: oxlint accepts them on every OS and
      // they match how --ignore-path/.gitignore patterns are anchored.
      targets.push(`packages/${name}/${sub}`);
    }
  }
}

if (targets.length === 0) {
  console.error("lint: found no packages/*/{src,internal,tests} directories to lint");
  process.exit(1);
}

const baseArgs = [
  "--react-plugin",
  "--node-plugin",
  "--import-plugin",
  "--ignore-path",
  ".gitignore",
  "-A",
  "react/no-children-prop",
  "-A",
  "unicorn/no-thenable",
  "--ignore-pattern",
  "packages/*/src/**/*.d.ts",
];

// Extra flags from the npm script (e.g. `--fix --fix-suggestions`).
const passthrough = process.argv.slice(2);

const result = spawnSync(process.execPath, [oxlintBin, ...baseArgs, ...passthrough, ...targets], {
  cwd: root,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);

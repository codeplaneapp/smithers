#!/usr/bin/env node
// Cross-platform `oxfmt` runner.
//
// The format scope is every `packages/*/{src,internal,tests}` directory plus `apps`,
// `scripts` and `.smithers` — i.e. the first-party JS/TS we author. Vendored
// and generated trees (`reference/`, `.opentui_temp/`, `dist/`, build output)
// are already listed in `.gitignore`, which oxfmt honours by default.
//
// Two things are resolved here in JS rather than left to the shell:
//
//   1. `packages/*/{src,tests}` — cmd.exe and PowerShell do not expand that
//      the way bash does, so an npm script containing the raw pattern would
//      break Windows CI exactly like the old `oxlint packages/*/src` did.
//   2. The extension list. oxfmt also formats Markdown, MDX, YAML, JSON and
//      CSS; pointing it at a directory would rewrite `docs/**/*.mdx` and the
//      `.smithers` prompt files, which the docs gates diff byte-for-byte.
//      Restricting the globs to JS/TS keeps the formatter on exactly the
//      files oxlint already lints — including its `.d.ts` exclusion, since
//      the committed declaration bundles are tsup output that check:dts
//      regenerates and compares byte-for-byte.
//
// The globs are passed to oxfmt as arguments (it expands them itself) without
// going through a shell, so no shell ever gets a chance to pre-expand or
// mangle them. oxfmt is invoked through its JS launcher via `node` to avoid
// the `.cmd`/`.exe` bin-shim resolution differences across platforms.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const oxfmtBin = join(dirname(require.resolve("oxfmt/package.json")), "bin", "oxfmt");

const EXTENSIONS = "{js,jsx,mjs,cjs,ts,tsx,mts,cts}";
const targets = [];

const packagesDir = join(root, "packages");
for (const name of readdirSync(packagesDir).sort()) {
  for (const sub of ["src", "internal", "tests"]) {
    if (existsSync(join(packagesDir, name, sub))) {
      // Forward-slash relative paths: oxfmt accepts them on every OS and they
      // match how .gitignore patterns are anchored.
      targets.push(`packages/${name}/${sub}/**/*.${EXTENSIONS}`);
    }
  }
}
for (const dir of ["apps", "scripts", ".smithers"]) {
  if (existsSync(join(root, dir))) targets.push(`${dir}/**/*.${EXTENSIONS}`);
}

if (targets.length === 0) {
  console.error("format: found no source directories to format");
  process.exit(1);
}

// Build output, not source. Both of these are regenerated from a generator that
// emits its own layout, and a gate re-runs the generator and fails on any drift
// (check:dts for the declaration bundles, check:sota and the workflow-pack
// generator for `*.generated.*`), so formatting them would guarantee drift.
targets.push("!**/*.d.{ts,mts,cts}", "!**/*.generated.*");
// packages/testing ships tsup-bundled .js in src/ (the publish drift gate
// rebuilds and byte-compares them), so formatting them guarantees drift.
targets.push("!packages/testing/src/**/*.js");
// examples/stereos-sandbox-provider/site is deploy output that
// `node examples/stereos-sandbox-provider/build.mjs` re-emits with its own
// layout (JSON.stringify payloads, verbatim page copies, a minified bundle), so
// formatting it guarantees drift on the next build.
targets.push("!examples/stereos-sandbox-provider/site/**/*.js");

// Extra flags from the npm script (e.g. `--check` or `--write`).
const passthrough = process.argv.slice(2);

const result = spawnSync(process.execPath, [oxfmtBin, ...passthrough, ...targets], {
  cwd: root,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);

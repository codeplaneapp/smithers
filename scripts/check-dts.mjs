#!/usr/bin/env node
// Freshness gate for committed declaration bundles. Regenerates them from
// source and fails if the committed output drifted — the type-side sibling of
// check-docs/check-llms. Runs in CI's `pnpm test` gate.
//
// Non-destructive: it snapshots the committed `.d.ts` under `pkg/src`, runs the
// real build to regenerate them, content-compares regenerated-vs-committed to
// detect drift, then ALWAYS restores the committed tree in a `finally` — even if
// the build throws. Each package build removes the declarations it generates
// before tsup rewrites them; without the restore, a transient tsup failure would
// leave tracked declarations deleted in this shared jj working tree. The net
// effect of this gate is zero: pass or fail, the tree ends byte-identical to how
// it started.
//
// Why in-place (not a throwaway temp outDir): tsup's dts bundler only emits the
// committed re-export form for `index.d.ts` when it writes to `src` itself. Point
// `--out-dir` anywhere else and it inlines those re-exports instead, so a temp
// build would report permanent false drift on `index.d.ts`. Regenerating into
// `src` and restoring afterward is the only way to compare like-for-like.
//
// Determinism note: the tsup dts build must pin `format: ["esm"]`, otherwise it
// emits `.d.cts` and this gate reports spurious drift.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(scriptPath), "..");
export const DEFAULT_DECLARATION_PACKAGES = [
  "packages/agents",
  "packages/cloudflare",
  "packages/gateway",
  "packages/graph",
  "packages/integrations",
  "packages/microsandbox",
  "packages/smithers",
];

/**
 * Snapshot every `.d.ts` under `srcDir` as a rel-path → content map.
 * @param {string} srcDir
 * @returns {Map<string, string>}
 */
function collectDeclarations(srcDir) {
  /** @type {Map<string, string>} */
  const out = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (path.endsWith(".d.ts")) {
        const rel = relative(srcDir, path).split(sep).join("/");
        out.set(rel, readFileSync(path, "utf8"));
      }
    }
  };
  walk(srcDir);
  return out;
}

/**
 * Restore `srcDir` to exactly the committed snapshot: delete any `.d.ts` the
 * build produced that wasn't committed, then rewrite the committed content
 * (overwriting whatever the build emitted, and recreating anything it deleted).
 * @param {string} srcDir
 * @param {Map<string, string>} committed
 */
function restoreDeclarations(srcDir, committed) {
  for (const rel of collectDeclarations(srcDir).keys()) {
    if (!committed.has(rel)) {
      rmSync(join(srcDir, rel));
    }
  }
  for (const [rel, content] of committed) {
    const dest = join(srcDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
}

/**
 * @param {{
 *   repoRoot?: string,
 *   packages?: readonly string[],
 *   runBuild?: (pkg: string, repoRoot: string) => void,
 *   write?: (message: string) => void,
 *   log?: (message: string) => void,
 *   error?: (message: string) => void,
 * }} [options]
 * @returns {boolean}
 */
export function checkDeclarations({
  repoRoot = defaultRepoRoot,
  packages = DEFAULT_DECLARATION_PACKAGES,
  runBuild = (pkg, root) =>
    execFileSync("pnpm", ["-C", pkg, "run", "build"], { cwd: root, stdio: "pipe" }),
  write = (message) => process.stdout.write(message),
  log = (message) => console.log(message),
  error = (message) => console.error(message),
} = {}) {
  let failed = false;
  for (const pkg of packages) {
    const cwd = join(repoRoot, pkg);
    const srcDir = join(cwd, "src");
    if (!existsSync(join(cwd, "tsup.config.ts"))) {
      error(`check-dts: ${pkg} has no tsup.config.ts`);
      failed = true;
      continue;
    }
    write(`check-dts: regenerating declarations for ${pkg}… `);
    const committed = collectDeclarations(srcDir);
    try {
      let buildError = null;
      try {
        runBuild(pkg, repoRoot);
      } catch (caught) {
        buildError = caught;
      }
      if (buildError) {
        error(
          `\ncheck-dts: build failed for ${pkg}\n${buildError.stdout ?? ""}${buildError.stderr ?? ""}`,
        );
        failed = true;
        continue; // finally restores the committed tree
      }
      const regenerated = collectDeclarations(srcDir);
      const drift = [];
      for (const [rel, content] of regenerated) {
        const before = committed.get(rel);
        if (before === undefined) {
          drift.push(`${rel} (missing — a new source module has no committed declaration)`);
        } else if (before !== content) {
          drift.push(`${rel} (stale — committed declaration differs from a fresh build)`);
        }
      }
      for (const rel of committed.keys()) {
        if (!regenerated.has(rel)) {
          drift.push(`${rel} (orphan — no source module produces this declaration anymore)`);
        }
      }
      if (drift.length > 0) {
        error("DRIFT");
        error(
          `check-dts: committed declarations in ${pkg}/src are stale. Run \`pnpm -C ${pkg} run build\` and commit the result:\n${drift.sort().join("\n")}`,
        );
        failed = true;
      } else {
        log("ok");
      }
    } finally {
      restoreDeclarations(srcDir, committed);
    }
  }
  return !failed;
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  let regressionTestsPassed = true;
  try {
    execFileSync(process.execPath, ["--test", "scripts/check-dts.test.mjs"], {
      cwd: defaultRepoRoot,
      stdio: "inherit",
    });
  } catch {
    regressionTestsPassed = false;
  }

  if (!regressionTestsPassed || !checkDeclarations()) {
    process.exitCode = 1;
  } else {
    console.log("check-dts: all per-file declarations are fresh");
  }
}

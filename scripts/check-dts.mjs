#!/usr/bin/env node
// Freshness gate for the per-file declaration bundles (packages that ship one
// `.d.ts` per source module so `pkg/<subpath>` resolves real types). Regenerates
// them from source and fails if the committed output drifted — the type-side
// sibling of check-docs/check-llms. Runs in CI's `pnpm test` gate.
//
// Non-destructive: it snapshots the committed `.d.ts` under `pkg/src`, runs the
// real build to regenerate them, content-compares regenerated-vs-committed to
// detect drift, then ALWAYS restores the committed tree in a `finally` — even if
// the build throws. Package builds remove their generated declarations before
// tsup runs (the whole tree for per-file packages, selected bundled entries for
// agents); without the restore, a transient tsup failure would leave tracked
// declarations deleted across agents, graph, integrations, OpenAPI, and the
// shared HTTP client
// (a nasty footgun in this shared jj working tree). The net effect of this gate
// is now zero: pass or fail, the tree ends byte-identical to how it started.
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
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = [
  "packages/agents",
  "packages/graph",
  "packages/http-client",
  "packages/integrations",
  "packages/openapi",
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
    const entries = readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.isFile() && path.endsWith(".d.ts")) {
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

let failed = false;
for (const pkg of packages) {
  const cwd = join(repoRoot, pkg);
  const srcDir = join(cwd, "src");
  if (!existsSync(join(cwd, "tsup.config.ts"))) {
    console.error(`check-dts: ${pkg} has no tsup.config.ts; skipping`);
    continue;
  }
  process.stdout.write(`check-dts: regenerating declarations for ${pkg}… `);
  const committed = collectDeclarations(srcDir);
  try {
    let buildError = null;
    try {
      execFileSync("pnpm", ["-C", pkg, "run", "build"], { cwd: repoRoot, stdio: "pipe" });
    } catch (error) {
      buildError = error;
    }
    if (buildError) {
      console.error(
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
      console.error("DRIFT");
      console.error(
        `check-dts: committed declarations in ${pkg}/src are stale. Run \`pnpm -C ${pkg} run build\` and commit the result:\n${drift.sort().join("\n")}`,
      );
      failed = true;
    } else {
      console.log("ok");
    }
  } finally {
    restoreDeclarations(srcDir, committed);
  }
}

if (failed) {
  process.exit(1);
}
console.log("check-dts: all per-file declarations are fresh");

#!/usr/bin/env bun
// Install the docs-driven-development pack into a target repo's .smithers/.
//
// DDD (ddd-generate-docs bootstraps features.json; docs-driven-development runs
// the audit→triage→implement→review loop over it) is part of the default init
// pack. This installer remains useful for older targets and for refreshing the
// complete standalone DDD closure; it copies the same portable files that a
// fresh `smithers init` seeds.
//
// The pack is agents-agnostic: the workflows import their providers from
// lib/ddd/dddAgents.ts, so the target repo's own .smithers/agents.ts is never
// read or clobbered.
//
// Usage: bun scripts/install-ddd-pack.ts <target-repo-dir>
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SMITHERS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(SMITHERS_ROOT, ".smithers");

// ddd-improve.tsx is intentionally NOT installed: it is the pack's own dev
// harness for the smithers repo (its verify gate runs `pnpm typecheck` +
// `bun test ./tests ./ui ./lib` against .smithers/, which doesn't exist at a
// target, and it licenses editing pack workflow files — the exact failure mode
// that corrupted a target's pack). The bootstrap + loop are what's portable.
const WORKFLOWS = [
  "ddd-generate-docs.tsx",
  "ddd-bug-scan.tsx",
  "docs-driven-development.tsx",
];

// Hand-authored UI modules the docs-driven-development UI imports. The
// ddd-*.generated.ts modules are intentionally omitted: `bun
// .smithers/lib/ddd/build.ts` regenerates them from the target's features.json.
const UI_FILES = [
  "docs-driven-development.tsx",
  "ddd-shared.tsx",
  "ddd-SpecsTab.tsx",
  "ddd-FeaturesTab.tsx",
  "ddd-AuditTab.tsx",
  "ddd-LiveTab.tsx",
  "ddd-TicketsTab.tsx",
  "ddd-StartPane.tsx",
  "ddd-Tutorial.tsx",
  "crepeTheme.generated.ts",
];

// Copy a required file; hard-fail if the source is missing (a rename in this
// repo must not yield a silently-broken install with a dangling import).
function copyRequired(relFromSmithers: string, targetSmithers: string) {
  const from = resolve(SRC, relFromSmithers);
  if (!existsSync(from)) {
    console.error(`Pack file missing in source (rename or drift?): .smithers/${relFromSmithers}`);
    process.exit(1);
  }
  const to = resolve(targetSmithers, relFromSmithers);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}

function main() {
  const targetArg = process.argv[2];
  if (!targetArg) {
    console.error("Usage: bun scripts/install-ddd-pack.ts <target-repo-dir>");
    process.exit(1);
  }
  const target = resolve(process.cwd(), targetArg);
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    console.error(`Target repo does not exist or is not a directory: ${target}`);
    process.exit(1);
  }

  // Warn BEFORE writing anything: a repo with its own (divergent) DDD, or an
  // existing pack install, means the operator should decide before we copy.
  const preExisting = [
    "docs/spec/features.json",
    "scripts/docs-driven-development",
    "docs/features.json",
  ].filter((rel) => existsSync(resolve(target, rel)));
  if (preExisting.length > 0) {
    console.log("⚠️  This repo already has a docs-driven-development system:");
    for (const rel of preExisting) console.log(`      ${rel}`);
    console.log("    The pack writes only .smithers/spec/features.json — it will NOT touch the");
    console.log("    existing spec. Keep them separate; do not let an agent merge them.");
    console.log("");
  }

  const targetSmithers = resolve(target, ".smithers");
  mkdirSync(targetSmithers, { recursive: true });
  const copied: string[] = [];

  // 1. lib/ddd — the generic scripts + self-contained agents module. Skip
  // tests and any nested dirs; the pack helpers are flat single files.
  for (const entry of readdirSync(resolve(SRC, "lib/ddd"), { withFileTypes: true })) {
    if (!entry.isFile() || /\.test\.tsx?$/.test(entry.name)) continue;
    copyRequired(`lib/ddd/${entry.name}`, targetSmithers);
    copied.push(`lib/ddd/${entry.name}`);
  }

  // 2. workflows — pure copy; the source already imports providers from
  // ../lib/ddd/dddAgents.ts, so the target's own agents.ts is never read.
  for (const wf of WORKFLOWS) {
    copyRequired(`workflows/${wf}`, targetSmithers);
    copied.push(`workflows/${wf}`);
  }

  // 3. ui modules (the loop UI; the bootstrap is headless). Required so the
  // docs-driven-development <UI> entry never has a dangling import at the target.
  for (const ui of UI_FILES) {
    copyRequired(`ui/${ui}`, targetSmithers);
    copied.push(`ui/${ui}`);
  }

  // Safety assertion: no copied file may still reference ../agents (the whole
  // point of dddAgents.ts). Fails loudly if a future edit reintroduces it.
  const leaked = copied.filter((rel) =>
    /from\s+["']\.\.\/agents(?:\.[tj]sx?)?["']|import\s+["']\.\.\/agents(?:\.[tj]sx?)?["']/.test(
      readFileSync(resolve(targetSmithers, rel), "utf8"),
    ),
  );
  if (leaked.length > 0) {
    console.error("Install aborted: these copied files still import ../agents (should use ../lib/ddd/dddAgents.ts):");
    for (const rel of leaked) console.error(`      .smithers/${rel}`);
    process.exit(1);
  }

  console.log(`Installed DDD pack into ${targetSmithers}`);
  console.log(`  ${copied.length} files copied.`);
  if (!existsSync(resolve(targetSmithers, "node_modules")) && !existsSync(resolve(target, "node_modules", "smithers-orchestrator"))) {
    console.log("  Note: run `smithers init` in the target first so smithers-orchestrator resolves.");
  }
  console.log("");
  console.log("Next steps (from the target repo root):");
  console.log("  bun .smithers/lib/ddd/build.ts                                   # validates + regenerates (empty starter spec is fine)");
  // Use the explicit workflow path: a stale/vendored `smithers` may fail to
  // resolve a bare workflow id (`smithers up ddd-generate-docs`).
  console.log("  smithers up .smithers/workflows/ddd-generate-docs.tsx -d -i '{\"runBugScan\": false}'   # bootstrap features.json");
  console.log("  smithers up .smithers/workflows/docs-driven-development.tsx -d   # run the improvement loop");
}

main();

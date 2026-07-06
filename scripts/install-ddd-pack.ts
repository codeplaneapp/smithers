#!/usr/bin/env bun
// Install the docs-driven-development pack into a target repo's .smithers/.
//
// DDD (ddd-generate-docs bootstraps features.json; docs-driven-development runs
// the audit→triage→implement→review loop over it) is an AUTHORED pack in this
// repo's .smithers/ — it is NOT in SEEDED_WORKFLOW_IDS, so `smithers init` does
// not ship it. To run DDD on another repo, that repo needs the pack's lib
// helpers, workflows, and (for the loop UI) the ddd UI modules. This script
// copies a self-contained set so the pack runs anywhere.
//
// The pack is agents-agnostic: the workflows import their providers from
// lib/ddd/dddAgents.ts, so the target repo's own .smithers/agents.ts is never
// read or clobbered.
//
// Usage: bun scripts/install-ddd-pack.ts <target-repo-dir>
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SMITHERS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(SMITHERS_ROOT, ".smithers");

const WORKFLOWS = [
  "ddd-generate-docs.tsx",
  "ddd-bug-scan.tsx",
  "ddd-improve.tsx",
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

function copyFile(relFromSmithers: string, targetSmithers: string) {
  const from = resolve(SRC, relFromSmithers);
  if (!existsSync(from)) return false;
  const to = resolve(targetSmithers, relFromSmithers);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
  return true;
}

function main() {
  const targetArg = process.argv[2];
  if (!targetArg) {
    console.error("Usage: bun scripts/install-ddd-pack.ts <target-repo-dir>");
    process.exit(1);
  }
  const target = resolve(process.cwd(), targetArg);
  if (!existsSync(target)) {
    console.error(`Target repo does not exist: ${target}`);
    process.exit(1);
  }
  const targetSmithers = resolve(target, ".smithers");
  mkdirSync(targetSmithers, { recursive: true });

  const copied: string[] = [];

  // 1. lib/ddd — the generic scripts + self-contained agents module.
  for (const entry of readdirSync(resolve(SRC, "lib/ddd"))) {
    if (entry.endsWith(".test.ts")) continue;
    if (copyFile(`lib/ddd/${entry}`, targetSmithers)) copied.push(`lib/ddd/${entry}`);
  }

  // 2. workflows. Rewrite the agents import so the pack never reads the target
  // repo's bespoke .smithers/agents.ts — DDD carries its own providers under
  // lib/ddd/dddAgents.ts.
  for (const wf of WORKFLOWS) {
    const from = resolve(SRC, "workflows", wf);
    if (!existsSync(from)) continue;
    const source = readFileSync(from, "utf8").replace(
      /from\s+["']\.\.\/agents["']/g,
      'from "../lib/ddd/dddAgents.ts"',
    );
    const to = resolve(targetSmithers, "workflows", wf);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, source);
    copied.push(`workflows/${wf}`);
  }

  // 3. ui modules (best-effort — the loop UI; bootstrap is headless).
  for (const ui of UI_FILES) {
    if (copyFile(`ui/${ui}`, targetSmithers)) copied.push(`ui/${ui}`);
  }

  console.log(`Installed DDD pack into ${targetSmithers}`);
  console.log(`  ${copied.length} files copied.`);
  console.log("");
  console.log("Next steps (from the target repo root):");
  console.log("  bun .smithers/lib/ddd/build.ts            # validates + regenerates (empty starter spec is fine)");
  console.log("  smithers up ddd-generate-docs -d -i '{\"runBugScan\": false}'   # bootstrap features.json");
  console.log("  smithers up docs-driven-development -d    # run the improvement loop");
}

main();

#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const faultsDir = join(root, "e2e", "faults");

const allowedSkips = new Map([
  ["e2e/faults/case01-kill-engine-mid-task.test.ts", 1],
  ["e2e/faults/case02-kill-sandbox-engine-alive.test.ts", 0],
  ["e2e/faults/case04-restart-waiting-event.test.ts", 1],
  ["e2e/faults/case05-restart-waiting-timer.test.ts", 1],
  ["e2e/faults/case07-continue-as-new-lineage.test.ts", 1],
  ["e2e/faults/case10-ghost-state-on-unmount.test.ts", 1],
  ["e2e/faults/case13-collapsed-ancestor-failure-marker.test.ts", 1],
  ["e2e/faults/case18-cron-manual-overlap.test.ts", 1],
  ["e2e/faults/case19-auth-persistence-suspend-resume.test.ts", 1],
  ["e2e/faults/case20-browser-automation-reference-runtime.test.ts", 1],
  ["e2e/faults/case21-file-vcs-pointer-integrity.test.ts", 1],
  ["e2e/faults/case25-approval-scope-denial.test.ts", 1],
  ["e2e/faults/case27-scorer-failure-blocks-downstream.test.ts", 1],
  ["e2e/faults/case28-soak-live-stream-rss.test.ts", 1],
  ["e2e/faults/case29-soak-cron-2h-no-stuck.test.ts", 1],
  ["e2e/faults/case30-soak-jjhub-long-lived.test.ts", 1],
]);

// Deliberately does not require a following "(": a case can also disable
// itself with `const d = cond ? describe : describe.skip`, which is still a
// skip and must stay tracked.
const skipPattern = /\b(?:test|describe|it)\.(skip(?:If)?|only|todo|failing)\b/g;
const allowedForbiddenModifiers = new Map([
  ["only", 0],
  ["todo", 0],
  ["failing", 0],
]);

function faultFiles() {
  return readdirSync(faultsDir)
    .filter((name) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name))
    .map((name) => join(faultsDir, name))
    .sort();
}

const observed = new Map();
let failed = false;

for (const file of faultFiles()) {
  const text = readFileSync(file, "utf8");
  const modifierCounts = new Map();
  for (const [, modifier] of text.matchAll(skipPattern)) {
    modifierCounts.set(modifier, (modifierCounts.get(modifier) ?? 0) + 1);
  }

  const count = (modifierCounts.get("skip") ?? 0) + (modifierCounts.get("skipIf") ?? 0);
  if (count > 0) observed.set(relative(root, file), count);

  for (const [modifier, allowed] of allowedForbiddenModifiers) {
    const actual = modifierCounts.get(modifier) ?? 0;
    if (actual !== allowed) {
      console.error(
        `[fault-skip-audit] unexpected .${modifier} fault test modifier in ${relative(root, file)}: expected ${allowed}, found ${actual}`,
      );
      failed = true;
    }
  }
}

for (const [file, count] of observed) {
  const allowed = allowedSkips.get(file);
  if (allowed !== count) {
    console.error(
      `[fault-skip-audit] unexpected skipped fault tests in ${file}: expected ${allowed ?? 0}, found ${count}`,
    );
    failed = true;
  }
}

for (const [file, count] of allowedSkips) {
  const actual = observed.get(file) ?? 0;
  if (actual !== count) {
    console.error(`[fault-skip-audit] tracked skip count changed in ${file}: expected ${count}, found ${actual}`);
    failed = true;
  }
}

if (!failed) {
  const total = [...observed.values()].reduce((sum, count) => sum + count, 0);
  console.log(`[fault-skip-audit] ${total} tracked skipped fault assertion(s); no untracked skips`);
}

if (failed) process.exit(1);

#!/usr/bin/env bun
// Seeds deterministic failed/stuck runs into the local smithers.db so the
// triage-run eval suites have real runs to diagnose. Idempotent: existing
// fixture runs are left alone. Run from anywhere inside the repo:
//
//   bun .smithers/evals/fixtures/seed-triage-fixtures.ts
//
// Expected terminal states: the three failure fixtures exit non-zero with run
// status "failed"; the two signoff fixtures exit with the suspend code and
// run status "waiting-approval".
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = resolve(FIXTURE_DIR, "triage-fixture.tsx");

const FIXTURES = [
  { runId: "triage-fixture-orders-csv", mode: "orders-csv" },
  { runId: "triage-fixture-upstream-fetch", mode: "upstream-fetch" },
  { runId: "triage-fixture-signoff", mode: "signoff" },
  { runId: "triage-fixture-orders-parse", mode: "orders-parse" },
  { runId: "triage-fixture-release-gate", mode: "signoff" },
];

function cli(args: string[]): { code: number; out: string } {
  const res = spawnSync("bunx", ["smithers-orchestrator", ...args], { encoding: "utf8" });
  return { code: res.status ?? 1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

let seeded = 0;
for (const fixture of FIXTURES) {
  const probe = cli(["inspect", fixture.runId, "--json"]);
  if (probe.code === 0) {
    console.log(`[seed] ${fixture.runId} already exists, skipping`);
    continue;
  }
  const up = cli([
    "up",
    WORKFLOW,
    "--run-id",
    fixture.runId,
    "--input",
    JSON.stringify({ mode: fixture.mode }),
  ]);
  const verify = cli(["inspect", fixture.runId, "--json"]);
  let state = "unknown";
  try {
    const parsed = JSON.parse(verify.out) as { state?: string; status?: string };
    state = String(parsed.state ?? parsed.status ?? "unknown");
  } catch {
    // leave unknown; the summary line below surfaces it.
  }
  console.log(`[seed] ${fixture.runId} (${fixture.mode}) -> up exit ${up.code}, state ${state}`);
  seeded += 1;
}

console.log(`[seed] done: ${seeded} new fixture run(s), ${FIXTURES.length - seeded} already present`);

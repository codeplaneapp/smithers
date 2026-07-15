import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const requiredReleaseNextWorkflows = ["CI", "Faults (per-PR)"];

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampOrNull(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isNewerRun(candidate, current) {
  const candidateRunNumber = numberOrNull(candidate.run_number);
  const currentRunNumber = numberOrNull(current.run_number);
  if (candidateRunNumber !== null && currentRunNumber !== null && candidateRunNumber !== currentRunNumber) {
    return candidateRunNumber > currentRunNumber;
  }

  // GitHub reruns keep their run number but increment the attempt number.
  const candidateAttempt = numberOrNull(candidate.run_attempt);
  const currentAttempt = numberOrNull(current.run_attempt);
  if (candidateAttempt !== null && currentAttempt !== null && candidateAttempt !== currentAttempt) {
    return candidateAttempt > currentAttempt;
  }

  for (const field of ["created_at", "updated_at"]) {
    const candidateTime = timestampOrNull(candidate[field]);
    const currentTime = timestampOrNull(current[field]);
    if (candidateTime !== null && currentTime !== null && candidateTime !== currentTime) {
      return candidateTime > currentTime;
    }
  }

  const candidateId = numberOrNull(candidate.id);
  const currentId = numberOrNull(current.id);
  return candidateId !== null && currentId !== null && candidateId > currentId;
}

export function selectLatestPushRuns(runs, requiredWorkflows = requiredReleaseNextWorkflows) {
  const latestByWorkflow = new Map(requiredWorkflows.map((name) => [name, null]));

  for (const run of runs) {
    if (run?.event !== "push" || !latestByWorkflow.has(run.name)) continue;
    const current = latestByWorkflow.get(run.name);
    if (!current || isNewerRun(run, current)) latestByWorkflow.set(run.name, run);
  }

  return latestByWorkflow;
}

export function evaluateReleaseNextGate(runs, requiredWorkflows = requiredReleaseNextWorkflows) {
  const latestByWorkflow = selectLatestPushRuns(runs, requiredWorkflows);
  const checks = requiredWorkflows.map((name) => {
    const run = latestByWorkflow.get(name);
    return { name, run, ready: run?.conclusion === "success" };
  });
  return { ready: checks.every((check) => check.ready), checks };
}

function printGateResult(result) {
  for (const check of result.checks) {
    if (!check.run) {
      console.log(`✗ ${check.name} has no push run for this commit`);
    } else if (!check.ready) {
      console.log(
        `✗ ${check.name}'s latest push run (#${check.run.run_number ?? "unknown"}) concluded ${check.run.conclusion ?? "without a conclusion"}`,
      );
    } else {
      console.log(`✓ ${check.name}'s latest push run (#${check.run.run_number ?? "unknown"}) succeeded`);
    }
  }
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch (error) {
    throw new Error(`could not parse workflow runs from stdin: ${error.message}`);
  }

  const runs = Array.isArray(payload) ? payload : payload?.workflow_runs;
  if (!Array.isArray(runs)) {
    throw new Error("workflow runs input must be an array or an object with a workflow_runs array");
  }

  const result = evaluateReleaseNextGate(runs);
  printGateResult(result);
  process.exitCode = result.ready ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`release-next gate failed: ${error.message}`);
    process.exitCode = 2;
  }
}

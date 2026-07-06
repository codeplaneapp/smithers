#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import type { FleetRun } from "./FleetRun";
import type { ShardTask } from "./ShardTask";
import { isTerminalStatus } from "./isTerminalStatus";
import { parseFleetRuns } from "./parseFleetRuns";
import { shouldResumeQuota } from "./shouldResumeQuota";

/**
 * Rollout-container entrypoint. Runs one subscription's shard DURABLY across the
 * Claude 5-hour rate limit: when this sub hits its window, smithers parks each
 * run as `waiting-quota` with the reset time, and the gateway daemon's
 * `processDueTimers` auto-resumes it at the boundary — no manual restart. The
 * worker's job is to keep the container (and therefore the daemon) alive until
 * every task reaches a terminal state, so those parks have something to wake
 * into. Fly Machines have no timeout, so a multi-hour wait is fine.
 *
 * Execution approval gates stay disabled by DelegationChain's default; the one
 * built-in goal-approval HumanTask is auto-approved so the run is unattended.
 *
 * Contract (env, injected per container by the launcher):
 *   CLAUDE_CODE_OAUTH_TOKEN  this container's subscription (no ANTHROPIC_* set)
 *   FLEET_SHARD_FILE         path to a JSON array of ShardTask
 *   FLEET_SMITHERS           smithers bin (default: `smithers`)
 *   FLEET_POLL_MS            supervise poll interval (default 30000)
 *   FLEET_DRY_RUN=1          print the plan instead of running it
 */
const smithers = process.env.FLEET_SMITHERS ?? "smithers";
const pollMs = Number(process.env.FLEET_POLL_MS ?? "30000");
const dryRun = process.env.FLEET_DRY_RUN === "1";

function loadShard(): ShardTask[] {
  const file = process.env.FLEET_SHARD_FILE;
  if (!file) throw new Error("worker: FLEET_SHARD_FILE is required");
  return JSON.parse(readFileSync(file, "utf8")) as ShardTask[];
}

function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });
}

function capture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.on("close", () => resolve(out));
    child.on("error", () => resolve(""));
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function pollRuns(runIds: string[]): Promise<FleetRun[]> {
  const raw = await capture(smithers, ["ps", "--json", "--limit", String(Math.max(runIds.length * 4, 200))]);
  try {
    return parseFleetRuns(JSON.parse(raw), runIds);
  } catch {
    return [];
  }
}

async function main() {
  const shard = loadShard();
  const runIds = shard.map((t) => t.runId);
  console.log(`worker: ${shard.length} task(s) on this subscription`);

  if (dryRun) {
    console.log(`  [dry-run] smithers gateway  +  smithers supervise  (durable control plane)`);
    for (const t of shard) {
      console.log(`  [dry-run] ${smithers} up ${t.workflow} -d --run-id ${t.runId} --input <json>`);
    }
    console.log(`  [dry-run] supervise until all terminal; waiting-quota auto-resumes at reset; waiting-approval auto-approved`);
    return;
  }

  // Durable control plane: the gateway daemon runs processDueTimers (quota
  // auto-resume) and the stale-run supervisor auto-resumes stuck runs. Both
  // kept alive for the whole shard.
  const gateway = spawn(smithers, ["gateway"], { stdio: "inherit" });
  gateway.on("error", () => {});
  const supervisor = spawn(smithers, ["supervise"], { stdio: "inherit" });
  supervisor.on("error", () => {});
  await sleep(2000);

  for (const task of shard) {
    await run(smithers, ["up", task.workflow, "-d", "--run-id", task.runId, "--input", JSON.stringify(task.input)]);
  }

  // Supervise to completion. The gateway auto-resumes quota parks at their
  // reset; we only step in for a window that has already passed (a backstop).
  for (;;) {
    const runs = await pollRuns(runIds);
    const byId = new Map(runs.map((r) => [r.runId, r]));
    const now = Date.now();
    let remaining = 0;
    let parked = 0;
    for (const id of runIds) {
      const r = byId.get(id);
      if (!r || !isTerminalStatus(r.status)) remaining++;
      if (r && r.status === "waiting-quota") {
        parked++;
        if (shouldResumeQuota(r, now)) {
          const task = shard.find((t) => t.runId === id)!;
          await run(smithers, ["up", task.workflow, "--resume", "--run-id", id, "-d", "--force"]);
        }
      }
      if (r && r.status === "waiting-approval") {
        const task = shard.find((t) => t.runId === id)!;
        await run(smithers, ["approve", id]);
        await run(smithers, ["up", task.workflow, "--resume", "--run-id", id, "-d", "--force"]);
      }
    }
    console.log(`worker: ${runIds.length - remaining}/${runIds.length} done` + (parked ? `, ${parked} parked on quota` : ""));
    if (remaining === 0) break;
    await sleep(pollMs);
  }

  gateway.kill();
  supervisor.kill();
  console.log("worker: shard complete");
}

main();

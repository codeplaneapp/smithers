// Evidence-based live-driver detection (#1056). Every case here drives real
// operating-system processes and the real classifier — a spawned child that is
// genuinely alive, the same child after it has been reaped, and this very test
// process standing in for a recycled PID.
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { formatRuntimeOwnerId } from "@smthrs/db/runtime-owner";
import {
  classifyRunDriverLiveness,
  describeLiveDriverRefusal,
  isRunDriverAlive,
  readProcessStartMs,
  STEAL_OWNERSHIP_FLAG,
} from "@smthrs/db/runDriverLiveness";

/** @type {Array<import("node:child_process").ChildProcess>} */
const spawned = [];

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
});

/** Spawn a real, long-lived process and return its pid once it exists. */
function spawnLiveDriver() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  spawned.push(child);
  return child;
}

/** Spawn a process and wait for it to actually exit, so its pid is dead. */
async function spawnDeadDriver() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}

function ownerIdFor(pid, sessionId = "driver") {
  return formatRuntimeOwnerId(pid, hostname(), sessionId);
}

describe("classifyRunDriverLiveness", () => {
  test("a real, running driver process counts as live", () => {
    const child = spawnLiveDriver();
    const now = Date.now();
    const liveness = classifyRunDriverLiveness(
      { status: "running", runtimeOwnerId: ownerIdFor(child.pid), heartbeatAtMs: now },
      { now },
    );
    expect(liveness.live).toBe(true);
    expect(liveness.evidence).toBe("owner-pid-alive");
    expect(liveness.ownerPid).toBe(child.pid);
  });

  test("a reaped driver process is NOT live, even with a heartbeat one second old", async () => {
    const pid = await spawnDeadDriver();
    const now = Date.now();
    const liveness = classifyRunDriverLiveness(
      { status: "running", runtimeOwnerId: ownerIdFor(pid), heartbeatAtMs: now - 1_000 },
      { now },
    );
    expect(liveness.live).toBe(false);
    expect(liveness.evidence).toBe("owner-pid-dead");
  });

  test("a recycled pid is not mistaken for the driver that wrote the heartbeat", () => {
    // This process is genuinely alive but started long after a heartbeat from
    // the epoch could possibly have been written by it.
    const now = Date.now();
    const liveness = classifyRunDriverLiveness(
      { status: "running", runtimeOwnerId: ownerIdFor(process.pid), heartbeatAtMs: 1_000_000 },
      { now },
    );
    expect(liveness.live).toBe(false);
    expect(liveness.evidence).toBe("owner-pid-recycled");
  });

  test("this process's start time is readable and precedes now", () => {
    const startedAtMs = readProcessStartMs(process.pid);
    expect(startedAtMs).not.toBeNull();
    expect(startedAtMs).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  test("an unreadable start time fails closed: a live pid stays live", () => {
    const child = spawnLiveDriver();
    const now = Date.now();
    const liveness = classifyRunDriverLiveness(
      { status: "running", runtimeOwnerId: ownerIdFor(child.pid), heartbeatAtMs: 1_000_000 },
      { now, readProcessStartMs: () => null },
    );
    expect(liveness.live).toBe(true);
    expect(liveness.evidence).toBe("owner-pid-alive");
  });

  test("a remote owner falls back to the durable heartbeat instead of a local pid probe", () => {
    const now = Date.now();
    const remoteOwner = formatRuntimeOwnerId(process.pid, `${hostname()}.remote`, "elsewhere");
    expect(
      classifyRunDriverLiveness({ status: "running", runtimeOwnerId: remoteOwner, heartbeatAtMs: now }, { now })
        .evidence,
    ).toBe("remote-owner-heartbeat");
    expect(
      classifyRunDriverLiveness(
        { status: "running", runtimeOwnerId: remoteOwner, heartbeatAtMs: now - 60_000 },
        { now },
      ).live,
    ).toBe(false);
  });

  test("a held durable resume claim is live; an expired one is not", () => {
    const now = Date.now();
    const claimOwner = "cli-resume:4321:1700000000000";
    expect(
      classifyRunDriverLiveness({ status: "waiting-approval", runtimeOwnerId: claimOwner, heartbeatAtMs: now }, { now })
        .evidence,
    ).toBe("resume-claim-held");
    expect(
      classifyRunDriverLiveness(
        { status: "waiting-approval", runtimeOwnerId: claimOwner, heartbeatAtMs: now - 45_000 },
        { now },
      ).live,
    ).toBe(false);
  });

  test("a run with no owner, or in a terminal state, is never live", () => {
    const child = spawnLiveDriver();
    const now = Date.now();
    expect(isRunDriverAlive({ status: "running", runtimeOwnerId: null, heartbeatAtMs: now }, { now })).toBe(false);
    for (const status of ["finished", "failed", "cancelled"]) {
      expect(isRunDriverAlive({ status, runtimeOwnerId: ownerIdFor(child.pid), heartbeatAtMs: now }, { now })).toBe(
        false,
      );
    }
  });

  test("the refusal message names the exact override flag", () => {
    const child = spawnLiveDriver();
    const now = Date.now();
    const liveness = classifyRunDriverLiveness(
      { status: "running", runtimeOwnerId: ownerIdFor(child.pid), heartbeatAtMs: now },
      { now },
    );
    const message = describeLiveDriverRefusal("run-1", liveness);
    expect(STEAL_OWNERSHIP_FLAG).toBe("--steal-ownership");
    expect(message).toContain("--steal-ownership");
    expect(message).not.toContain("--force");
  });
});

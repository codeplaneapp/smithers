import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { runCommandEffect } from "../src/BaseCliAgent/runCommandEffect.js";

// #1464 AWF-3 / #1332: agent CLIs must spawn as their own process-group
// leaders (POSIX) so cleanup and the orphan reaper can address the whole
// group — a bare `child.kill()` on the wrapper pid leaves subagents, MCP
// servers, and tool children running unsupervised.

describe("runCommandEffect process groups", () => {
  test("agent commands spawn detached so the child leads its own process group", async () => {
    if (process.platform === "win32") return;
    const controller = new AbortController();
    /** @type {number | undefined} */
    let startedPid;
    const run = Effect.runPromise(
      runCommandEffect("node", ["-e", "setInterval(() => {}, 1000)"], {
        cwd: process.cwd(),
        env: process.env,
        signal: controller.signal,
        onProcess: (event) => {
          if (event.phase === "started") startedPid = event.pid;
        },
      }),
    ).catch(() => undefined);
    const deadline = Date.now() + 10_000;
    while (startedPid == null && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    expect(typeof startedPid).toBe("number");
    // A group leader answers a group probe; a non-detached child has no
    // group of its own and kill(-pid, 0) raises ESRCH.
    let groupAlive = false;
    try {
      process.kill(-startedPid, 0);
      groupAlive = true;
    } catch {
      groupAlive = false;
    }
    expect(groupAlive).toBe(true);
    // Aborting must kill the whole group, not just the wrapper pid.
    controller.abort();
    await run;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    let stillAlive = true;
    try {
      process.kill(startedPid, 0);
    } catch {
      stillAlive = false;
    }
    expect(stillAlive).toBe(false);
  }, 20_000);
});

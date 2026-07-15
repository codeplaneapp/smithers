import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { terminateChild } from "./terminateChild.mjs";

function pendingChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

describe("terminateChild", () => {
  test("cancels the losing grace timer after a real child exits", async () => {
    const moduleUrl = new URL("./terminateChild.mjs", import.meta.url).href;
    const script = [
      `import { spawn } from "node:child_process";`,
      `import { terminateChild } from ${JSON.stringify(moduleUrl)};`,
      `const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
      `child.once("spawn", async () => { await terminateChild(child, { timeoutMs: 2000, killTimeoutMs: 100 }); });`,
    ].join("\n");
    const startedAt = Date.now();
    const wrapper = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    wrapper.stderr.on("data", (chunk) => { stderr += chunk; });
    const [code] = await once(wrapper, "close");

    expect(code, stderr).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(1_200);
  }, 10_000);

  test("uses taskkill for the full process tree on Windows", async () => {
    const child = pendingChild(4242);
    const taskkillPids = [];

    await terminateChild(child, {
      platform: "win32",
      timeoutMs: 20,
      killTimeoutMs: 20,
      runTaskkill: async (pid) => {
        taskkillPids.push(pid);
        child.exitCode = 1;
        child.emit("exit", 1, null);
        return true;
      },
      kill: () => { throw new Error("Windows cleanup must use taskkill"); },
    });

    expect(taskkillPids).toEqual([4242]);
  });

  test("falls back to the child pid when taskkill itself fails", async () => {
    const child = pendingChild(4343);
    const signals = [];

    await terminateChild(child, {
      platform: "win32",
      killTimeoutMs: 10,
      runTaskkill: () => false,
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        child.signalCode = signal;
        child.emit("exit", null, signal);
      },
    });

    expect(signals).toEqual([[4343, "SIGKILL"]]);
  });

  test("bounds the post-SIGKILL wait when a child never emits exit", async () => {
    const child = pendingChild(5151);
    const signals = [];
    const startedAt = Date.now();

    await terminateChild(child, {
      timeoutMs: 10,
      killTimeoutMs: 15,
      kill: (target, signal) => { signals.push([target, signal]); },
    });

    expect(signals).toEqual([[5151, "SIGTERM"], [5151, "SIGKILL"]]);
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  test("returns without signalling when spawn failed before assigning a pid", async () => {
    const child = pendingChild(undefined);
    let signalled = false;

    await terminateChild(child, {
      timeoutMs: 10,
      kill: () => { signalled = true; },
    });

    expect(signalled).toBe(false);
  });
});

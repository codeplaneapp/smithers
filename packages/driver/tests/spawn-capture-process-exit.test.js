import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { spawnCaptureEffect } from "../src/child-process.js";

const tmpDir = process.cwd();

/**
 * Regression coverage for #1582: `onProcess` must report the OS-level death of
 * the spawned worker, with its exit code or signal, even when the capture
 * promise cannot settle because a grandchild still holds the stdio pipes.
 */
describe("spawnCaptureEffect process-exit notifications", () => {
  test("reports the exit code of a worker that exits normally", async () => {
    /** @type {any[]} */
    const events = [];
    await Effect.runPromise(
      spawnCaptureEffect("node", ["-e", "process.exit(3)"], {
        cwd: tmpDir,
        onProcess: (event) => events.push(event),
      }),
    );
    const started = events.find((event) => event.phase === "started");
    const exited = events.find((event) => event.phase === "exited");
    expect(started?.pid).toBeGreaterThan(0);
    expect(exited).toBeDefined();
    expect(exited.exitCode).toBe(3);
    expect(exited.signal).toBeNull();
    expect(events.filter((event) => event.phase === "exited")).toHaveLength(1);
  });

  test("reports the killing signal, and does so before a pipe-holding grandchild lets the capture settle", async () => {
    /** @type {any[]} */
    const events = [];
    const script = [
      "const { spawn } = require('node:child_process');",
      // Inherits stdout/stderr, so the parent's `close` cannot fire while it lives.
      "const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
      "holder.unref();",
      "process.stdout.write('alive');",
      "process.kill(process.pid, 'SIGKILL');",
      "setTimeout(() => {}, 30000);",
    ].join("\n");

    const capture = Effect.runPromiseExit(
      spawnCaptureEffect("node", ["-e", script], {
        cwd: tmpDir,
        detached: true,
        timeoutMs: 30_000,
        onProcess: (event) => events.push({ ...event, atMs: Date.now() }),
      }),
    );

    const deadline = Date.now() + 10_000;
    while (!events.some((event) => event.phase === "exited") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const exited = events.find((event) => event.phase === "exited");
    expect(exited).toBeDefined();
    if (process.platform === "win32") {
      // Windows has no POSIX signals: libuv turns `process.kill(pid, "SIGKILL")`
      // into TerminateProcess, which node reports as a plain non-zero exit with
      // a null signal. The property under test — that the death is reported at
      // all, ahead of the capture settling — is the same either way.
      expect(exited.signal).toBeNull();
      expect(exited.exitCode).not.toBeNull();
    } else {
      expect(exited.signal).toBe("SIGKILL");
      expect(exited.exitCode).toBeNull();
    }

    // The worker is provably dead while the capture is still outstanding: the
    // effect only settles once the pipe holder finally goes away, seconds
    // later. That gap is what parks an engine attempt forever without the
    // #1582 fix, which is why liveness cannot be read off the capture promise.
    const settledEarly = await Promise.race([
      capture.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    expect(settledEarly).toBe(false);

    const exit = await capture;
    expect(Exit.isExit(exit)).toBe(true);
    expect(Date.now() - exited.atMs).toBeGreaterThan(2_000);
  }, 30_000);
});

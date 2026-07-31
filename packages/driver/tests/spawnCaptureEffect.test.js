import { describe, expect, test } from "bun:test";
import { Effect, Exit, Cause, Fiber } from "effect";
import { ChildProcess } from "node:child_process";
import { spawnCaptureEffect } from "../src/child-process.js";

const tmpDir = process.cwd();

/**
 * Run a `spawnCaptureEffect` and return the result, or surface the failure as
 * a rejection so tests can use `await expect(...).rejects.toThrow(...)`.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {import("../src/SpawnCaptureOptions.ts").SpawnCaptureOptions} options
 * @returns {Promise<import("../src/SpawnCaptureResult.ts").SpawnCaptureResult>}
 */
async function run(command, args, options) {
  const exit = await Effect.runPromiseExit(spawnCaptureEffect(command, args, { cwd: tmpDir, ...options }));
  if (Exit.isSuccess(exit)) return exit.value;
  const failureOption = Cause.findErrorOption(exit.cause);
  if (failureOption._tag === "Some") throw failureOption.value;
  throw new Error(Cause.pretty(exit.cause));
}

/** @param {number | undefined} pid */
function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** @param {number | undefined} pid */
function killPid(pid) {
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already exited
  }
}

const descendantHoldingStdoutScript = [
  'const { spawn } = require("node:child_process");',
  'const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {',
  '  stdio: ["ignore", "inherit", "inherit"],',
  "});",
  'process.stdout.write(String(descendant.pid) + "\\n");',
  "setTimeout(() => {}, 30000);",
].join("\n");

/**
 * @param {(pid: number) => void} onPid
 */
function descendantPidCollector(onPid) {
  let buffered = "";
  return (chunk) => {
    buffered += chunk;
    const lineEnd = buffered.indexOf("\n");
    if (lineEnd < 0) return;
    const pid = Number(buffered.slice(0, lineEnd));
    if (Number.isInteger(pid) && pid > 0) onPid(pid);
  };
}

function installTimerSpy() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const created = new Map();
  const cleared = new Set();
  globalThis.setTimeout = /** @type {any} */ (
    (fn, ms, ...rest) => {
      const timer = realSetTimeout(fn, ms, ...rest);
      created.set(timer, ms);
      return timer;
    }
  );
  globalThis.clearTimeout = /** @type {any} */ (
    (timer) => {
      cleared.add(timer);
      return realClearTimeout(timer);
    }
  );
  return {
    created,
    cleared,
    realSetTimeout,
    restore() {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

describe("spawnCaptureEffect — happy path", () => {
  test("captures stdout when process exits 0", async () => {
    const result = await run("node", ["-e", "process.stdout.write('hello-world')"], {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello-world");
    expect(result.stderr).toBe("");
  });

  test("captures stderr when process exits 0", async () => {
    const result = await run("node", ["-e", "process.stderr.write('warn'); process.exit(0)"], {});
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("warn");
  });

  test("captures non-zero exit codes without throwing", async () => {
    const result = await run("node", ["-e", "process.exit(7)"], {});
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe("");
  });

  test("non-zero exit surfaces stderr in result", async () => {
    const result = await run("node", ["-e", "process.stderr.write('boom'); process.exit(2)"], {});
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("boom");
  });

  test("process that never writes anything is handled cleanly", async () => {
    const result = await run("node", ["-e", "setTimeout(()=>{}, 0)"], {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("partial JSON in stderr is captured verbatim — caller decides how to parse", async () => {
    const partial = '{"foo":"bar","baz":';
    const result = await run("node", ["-e", `process.stderr.write(${JSON.stringify(partial)})`], {});
    expect(result.stderr).toBe(partial);
    // Confirm that downstream JSON parsing can handle it without crashing the captor
    expect(() => JSON.parse(result.stderr)).toThrow();
  });

  test("input is piped to stdin", async () => {
    const result = await run(
      "node",
      [
        "-e",
        "let s=''; process.stdin.on('data', d=>s+=d); process.stdin.on('end', ()=> process.stdout.write(s.toUpperCase()))",
      ],
      { input: "hello" },
    );
    expect(result.stdout).toBe("HELLO");
  });
});

describe("spawnCaptureEffect — output limits", () => {
  test("stdout exceeding maxOutputBytes is truncated", async () => {
    // Write 50 KB of 'A's; cap at 1 KB
    const result = await run("node", ["-e", "const buf = 'A'.repeat(50_000); process.stdout.write(buf)"], {
      maxOutputBytes: 1_000,
    });
    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(1_000);
    expect(result.stdout.startsWith("A")).toBe(true);
  });

  test("stderr exceeding maxOutputBytes is truncated", async () => {
    const result = await run("node", ["-e", "const buf = 'B'.repeat(50_000); process.stderr.write(buf)"], {
      maxOutputBytes: 1_000,
    });
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(1_000);
  });

  test("default maxOutputBytes (200KB) — output near-but-under cap not truncated", async () => {
    // 100 KB — well under 200 KB default
    const result = await run("node", ["-e", "process.stdout.write('A'.repeat(100_000))"], {});
    expect(result.stdout.length).toBe(100_000);
  });

  test("truncated stdout that contains JSON — downstream parse fails predictably", async () => {
    // Write a long string of JSON; cap so it is cut mid-object.
    const result = await run(
      "node",
      [
        "-e",
        `const obj = { items: Array(5000).fill({ k: 'v', n: 1234567890 }) };
         process.stdout.write(JSON.stringify(obj));`,
      ],
      { maxOutputBytes: 200 },
    );
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(200);
    expect(() => JSON.parse(result.stdout)).toThrow();
  });
});

describe("spawnCaptureEffect — timeouts and cancellation", () => {
  test("hard timeout fires with PROCESS_TIMEOUT", async () => {
    await expect(run("node", ["-e", "setTimeout(() => {}, 10_000)"], { timeoutMs: 100 })).rejects.toMatchObject({
      code: "PROCESS_TIMEOUT",
    });
  });

  test.skipIf(process.platform === "win32")(
    "hard timeout does not wait for a descendant-held stdout pipe",
    { timeout: 5_000 },
    async () => {
      let descendantPid;
      const cleanupTimer = setTimeout(() => killPid(descendantPid), 1_500);
      const startedAt = Date.now();
      try {
        await expect(
          run("node", ["-e", descendantHoldingStdoutScript], {
            timeoutMs: 200,
            onStdout: descendantPidCollector((pid) => {
              descendantPid = pid;
            }),
          }),
        ).rejects.toMatchObject({ code: "PROCESS_TIMEOUT" });
      } finally {
        clearTimeout(cleanupTimer);
        killPid(descendantPid);
      }
      expect(descendantPid).toBeGreaterThan(0);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    },
  );

  test("idle timeout fires with PROCESS_IDLE_TIMEOUT", { timeout: 10_000 }, async () => {
    await expect(
      run("node", ["-e", "process.stdout.write('hi'); setTimeout(()=>{}, 10_000)"], { idleTimeoutMs: 1_000 }),
    ).rejects.toMatchObject({
      code: "PROCESS_IDLE_TIMEOUT",
      message: expect.stringContaining(`CLI idle timed out after ${process.versions.bun ? 5_000 : 1_000}ms`),
    });
  });

  test("idle timer resets on stdout activity", async () => {
    // Process emits ticks for longer than the idle timeout. Without resetting
    // on stdout activity, this would fail around 500ms.
    // It should never time out because each tick resets the idle timer.
    const result = await run(
      "node",
      [
        "-e",
        [
          "let ticks = 0;",
          "const interval = setInterval(() => {",
          "  ticks += 1;",
          "  process.stdout.write(`tick ${ticks}\\n`);",
          "  if (ticks === 10) {",
          "    clearInterval(interval);",
          "  }",
          "}, 100);",
        ].join("\n"),
      ],
      { idleTimeoutMs: 500 },
    );
    expect(result.stdout).toContain("tick");
    expect(result.exitCode).toBe(0);
  });

  test("abort signal already aborted: PROCESS_ABORTED", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(run("node", ["-e", "setTimeout(()=>{}, 5000)"], { signal: ac.signal })).rejects.toMatchObject({
      code: "PROCESS_ABORTED",
    });
  });

  test("abort mid-run kills the process", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await expect(
      run("node", ["-e", "setTimeout(()=>{ process.stdout.write('done') }, 5000)"], { signal: ac.signal }),
    ).rejects.toMatchObject({ code: "PROCESS_ABORTED" });
  });

  test.skipIf(process.platform === "win32")(
    "failed signal delivery is bounded and is not reported as process exit",
    { timeout: 5_000 },
    async () => {
      const processEvents = [];
      let pid;
      const originalKill = ChildProcess.prototype.kill;
      ChildProcess.prototype.kill = function () {
        queueMicrotask(() => this.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" })));
        return false;
      };
      const startedAt = Date.now();
      try {
        await expect(
          run("node", ["-e", "setTimeout(() => {}, 10_000)"], {
            timeoutMs: 30,
            onProcess: (event) => {
              processEvents.push(event);
              if (event.phase === "started") pid = event.pid;
            },
          }),
        ).rejects.toMatchObject({ code: "PROCESS_TIMEOUT" });
        expect(Date.now() - startedAt).toBeLessThan(2_000);
        expect(processEvents.map(({ phase }) => phase)).toEqual(["started"]);
        expect(isPidAlive(pid)).toBe(true);
      } finally {
        ChildProcess.prototype.kill = originalKill;
        killPid(pid);
      }
    },
  );

  test("external abort and timeout terminal paths clear every configured deadline", async () => {
    const cases = [
      {
        expectedCode: "PROCESS_ABORTED",
        options: (timers) => {
          const controller = new AbortController();
          timers.realSetTimeout(() => controller.abort(), 30);
          return { signal: controller.signal, timeoutMs: 1_000_000, idleTimeoutMs: 1_000_000 };
        },
      },
      {
        expectedCode: "PROCESS_TIMEOUT",
        options: () => ({ timeoutMs: 50, idleTimeoutMs: 1_000_000 }),
      },
      {
        expectedCode: "PROCESS_IDLE_TIMEOUT",
        options: () => ({ timeoutMs: 1_000_000, idleTimeoutMs: 50 }),
      },
    ];
    for (const testCase of cases) {
      const timers = installTimerSpy();
      try {
        await expect(run("node", ["-e", "setTimeout(()=>{}, 10_000)"], testCase.options(timers))).rejects.toMatchObject(
          { code: testCase.expectedCode },
        );
        const configured = [...timers.created].filter(([, ms]) => ms === 50 || ms === 1_000_000);
        expect(configured.length).toBeGreaterThanOrEqual(2);
        for (const [timer] of configured) {
          expect(timers.cleared.has(timer)).toBe(true);
        }
      } finally {
        timers.restore();
      }
    }
  });

  test("detached timeout kills the process group", async () => {
    await expect(
      run("node", ["-e", "setTimeout(()=>{}, 10_000)"], { detached: true, timeoutMs: 80 }),
    ).rejects.toMatchObject({ code: "PROCESS_TIMEOUT" });
  });

  test("detached timeout falls back when process-group kill throws", async () => {
    const originalKill = process.kill;
    process.kill = (pid, signal) => {
      if (typeof pid === "number" && pid < 0) {
        throw new Error("process group unavailable");
      }
      return originalKill(pid, signal);
    };
    try {
      await expect(
        run("node", ["-e", "setTimeout(()=>{}, 10_000)"], { detached: true, timeoutMs: 80 }),
      ).rejects.toMatchObject({ code: "PROCESS_TIMEOUT" });
    } finally {
      process.kill = originalKill;
    }
  });

  test("interrupting the Effect runs the non-detached cleanup finalizer", async () => {
    const processEvents = [];
    const fiber = Effect.runFork(
      spawnCaptureEffect("node", ["-e", "setTimeout(()=>{}, 10_000)"], {
        cwd: tmpDir,
        timeoutMs: 10_000,
        idleTimeoutMs: 10_000,
        onProcess: (event) => processEvents.push(event),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await Effect.runPromise(Fiber.interrupt(fiber));
    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(processEvents.map(({ phase }) => phase)).toEqual(["started", "exited"]);
    expect(isPidAlive(processEvents[0]?.pid)).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "interrupting does not wait for a descendant-held stdout pipe",
    { timeout: 5_000 },
    async () => {
      let descendantPid;
      /** @type {(pid: number) => void} */
      let resolveDescendantPid = () => {};
      const observedDescendantPid = new Promise((resolve) => {
        resolveDescendantPid = resolve;
      });
      const fiber = Effect.runFork(
        spawnCaptureEffect("node", ["-e", descendantHoldingStdoutScript], {
          cwd: tmpDir,
          onStdout: descendantPidCollector((pid) => {
            descendantPid = pid;
            resolveDescendantPid(pid);
          }),
        }),
      );
      await observedDescendantPid;
      const cleanupTimer = setTimeout(() => killPid(descendantPid), 1_500);
      const startedAt = Date.now();
      try {
        await Effect.runPromise(Fiber.interrupt(fiber));
      } finally {
        clearTimeout(cleanupTimer);
        killPid(descendantPid);
      }
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    },
  );

  test("interrupting a detached Effect uses kill fallback when group kill throws", async () => {
    const ac = new AbortController();
    const processEvents = [];
    const groupKills = [];
    const originalKill = process.kill;
    process.kill = (pid, signal) => {
      if (typeof pid === "number" && pid < 0) {
        groupKills.push({ pid, signal });
        throw new Error("process group unavailable");
      }
      return originalKill(pid, signal);
    };
    try {
      const fiber = Effect.runFork(
        spawnCaptureEffect("node", ["-e", "setTimeout(()=>{}, 10_000)"], {
          cwd: tmpDir,
          detached: true,
          timeoutMs: 10_000,
          idleTimeoutMs: 10_000,
          signal: ac.signal,
          onProcess: (event) => processEvents.push(event),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      await Effect.runPromise(Fiber.interrupt(fiber));
      const exit = await Effect.runPromise(Fiber.await(fiber));
      expect(Exit.isFailure(exit)).toBe(true);
      ac.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(groupKills).toHaveLength(1);
      expect(processEvents.map(({ phase }) => phase)).toEqual(["started", "exited"]);
      expect(isPidAlive(processEvents[0]?.pid)).toBe(false);
    } finally {
      process.kill = originalKill;
    }
  });
});

describe("spawnCaptureEffect — abort after a successful close (issue #683)", () => {
  test("an exited callback that aborts cannot replace a successful result", async () => {
    const ac = new AbortController();
    const processEvents = [];
    const result = await run("node", ["-e", "process.stdout.write('ok')"], {
      signal: ac.signal,
      onProcess: (event) => {
        processEvents.push(event);
        if (event.phase === "exited") ac.abort();
      },
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "ok" });
    expect(processEvents.map(({ phase }) => phase)).toEqual(["started", "exited"]);
  });

  test("a late abort on a detached child does not kill the (possibly reused) process group", async () => {
    const ac = new AbortController();
    /** @type {(number | string)[]} */
    const killedPids = [];
    const originalKill = process.kill;
    process.kill = (pid, signal) => {
      killedPids.push(pid);
      return originalKill(pid, signal);
    };
    try {
      const result = await run("node", ["-e", "process.stdout.write('ok')"], {
        detached: true,
        signal: ac.signal,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("ok");

      // Run shutdown aborts the same controller long after the child closed.
      ac.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(killedPids).toEqual([]);
    } finally {
      process.kill = originalKill;
    }
  });

  test("finalize unregisters the abort listener", async () => {
    const ac = new AbortController();
    const removed = [];
    const originalRemove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.removeEventListener = (type, listener, options) => {
      removed.push(type);
      return originalRemove(type, listener, options);
    };
    try {
      const result = await run("node", ["-e", "process.stdout.write('done')"], {
        signal: ac.signal,
      });
      expect(result.stdout).toBe("done");
      expect(removed).toContain("abort");
    } finally {
      ac.signal.removeEventListener = originalRemove;
    }
  });
});

describe("spawnCaptureEffect — external kill / spawn errors", () => {
  test("process killed externally exits with null code, no throw", async () => {
    // Self-kill via SIGKILL — we treat this like an external kill since the
    // captor sees only the close event, not our intent.
    const result = await run("node", ["-e", "process.kill(process.pid, 'SIGKILL')"], {});
    // Node returns null exit code when terminated by signal
    expect(
      result.exitCode === null || result.exitCode === 137 || (process.platform === "win32" && result.exitCode === 1),
    ).toBe(true);
  });

  test("non-existent command surfaces PROCESS_SPAWN_FAILED", async () => {
    try {
      await run("/nonexistent/binary-does-not-exist", ["--api-key", "opaque-driver-canary"], {});
      throw new Error("expected spawn failure");
    } catch (error) {
      const serialized = JSON.stringify(error);
      expect(error.code).toBe("PROCESS_SPAWN_FAILED");
      expect(serialized).toContain("[REDACTED]");
      expect(serialized).not.toContain("opaque-driver-canary");
      expect(serialized).not.toContain("spawnargs");
    }
  });

  test("an exited callback that aborts cannot replace a spawn failure", async () => {
    const ac = new AbortController();
    const processEvents = [];
    try {
      await run("/nonexistent/binary-does-not-exist", [], {
        signal: ac.signal,
        onProcess: (event) => {
          processEvents.push(event);
          if (event.phase === "exited") ac.abort();
        },
      });
      throw new Error("expected spawn failure");
    } catch (error) {
      expect(error.code).toBe("PROCESS_SPAWN_FAILED");
    }
    expect(processEvents.map(({ phase }) => phase)).toEqual(["started", "exited"]);
  });
});

describe("spawnCaptureEffect — stdin EPIPE handling", () => {
  test("large input to a child that closes stdin and exits does not crash with uncaught EPIPE", async () => {
    // Child immediately closes its stdin and exits. Writing a large payload
    // into the pipe after the reader is gone triggers an EPIPE error event on
    // the parent's child.stdin stream. Without an "error" listener on stdin,
    // that becomes an uncaught exception and crashes the process. The effect
    // must instead settle (succeed/fail with a handled error).
    let unhandled = null;
    const onUnhandled = (err) => {
      unhandled = err;
    };
    process.on("uncaughtException", onUnhandled);
    try {
      // ~1 MB payload, well over a pipe buffer, so the write cannot fully
      // flush before the child has gone away.
      const bigInput = "x".repeat(1_000_000);
      const result = await run("node", ["-e", "process.stdin.destroy(); process.exit(0)"], { input: bigInput });
      // The task settled cleanly rather than crashing.
      expect(typeof result.exitCode === "number" || result.exitCode === null).toBe(true);
    } finally {
      // Give any deferred error event a tick to land before asserting.
      await new Promise((resolve) => setTimeout(resolve, 50));
      process.removeListener("uncaughtException", onUnhandled);
    }
    expect(unhandled).toBeNull();
  });
});

describe("spawnCaptureEffect — concurrency / fd hygiene", () => {
  test("spawns 20 cheap processes concurrently without leaking", async () => {
    const N = 20;
    const promises = Array.from({ length: N }, (_, i) => run("node", ["-e", `process.stdout.write('p${i}')`], {}));
    const results = await Promise.all(promises);
    expect(results.length).toBe(N);
    for (let i = 0; i < N; i++) {
      expect(results[i].exitCode).toBe(0);
      expect(results[i].stdout).toBe(`p${i}`);
    }
  });

  test("concurrent timeouts all surface their own error", async () => {
    const N = 5;
    const settled = await Promise.allSettled(
      Array.from({ length: N }, () => run("node", ["-e", "setTimeout(()=>{}, 10_000)"], { timeoutMs: 80 })),
    );
    for (const s of settled) {
      expect(s.status).toBe("rejected");
      expect(s.reason.code).toBe("PROCESS_TIMEOUT");
    }
  });
});

describe("spawnCaptureEffect — onStdout / onStderr callbacks", () => {
  test("onStdout receives streamed chunks", async () => {
    const chunks = [];
    const result = await run(
      "node",
      ["-e", "process.stdout.write('one'); setTimeout(()=>process.stdout.write('two'), 30)"],
      { onStdout: (c) => chunks.push(c) },
    );
    expect(result.stdout).toBe("onetwo");
    expect(chunks.join("")).toBe("onetwo");
  });

  test("onStderr receives streamed chunks", async () => {
    const chunks = [];
    await run("node", ["-e", "process.stderr.write('e1'); setTimeout(()=>process.stderr.write('e2'), 20)"], {
      onStderr: (c) => chunks.push(c),
    });
    expect(chunks.join("")).toBe("e1e2");
  });
});

describe("spawnCaptureEffect — truncation policy (issue #277)", () => {
  const emitter = "process.stdout.write('HEAD-SENTINEL-' + 'x'.repeat(30000) + '-TAIL-SENTINEL')";

  test("keeps the head by default and sets stdoutTruncated", async () => {
    const result = await run("node", ["-e", emitter], {
      maxOutputBytes: 5_000,
    });
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.startsWith("HEAD-SENTINEL-")).toBe(true);
    expect(result.stdout).not.toContain("TAIL-SENTINEL");
  });

  test("truncateKeep tail keeps the end of the stream", async () => {
    const result = await run("node", ["-e", emitter], {
      maxOutputBytes: 5_000,
      truncateKeep: "tail",
    });
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.endsWith("-TAIL-SENTINEL")).toBe(true);
    expect(result.stdout).not.toContain("HEAD-SENTINEL");
  });

  test("flags stay false when output fits the cap", async () => {
    const result = await run("node", ["-e", "process.stdout.write('small')"], { maxOutputBytes: 5_000 });
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderrTruncated).toBe(false);
    expect(result.stdout).toBe("small");
  });

  test("truncateKeep tail applies to stdout only; stderr keeps its head", async () => {
    const result = await run("node", ["-e", "process.stderr.write('ERR-HEAD-' + 'e'.repeat(30000) + '-ERR-TAIL')"], {
      maxOutputBytes: 5_000,
      truncateKeep: "tail",
    });
    expect(result.stderrTruncated).toBe(true);
    expect(result.stderr.startsWith("ERR-HEAD-")).toBe(true);
    expect(result.stderr).not.toContain("-ERR-TAIL");
  });
});

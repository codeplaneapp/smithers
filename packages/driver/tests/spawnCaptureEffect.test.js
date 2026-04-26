import { describe, expect, test } from "bun:test";
import { Effect, Exit, Cause } from "effect";
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
  const exit = await Effect.runPromiseExit(
    spawnCaptureEffect(command, args, { cwd: tmpDir, ...options }),
  );
  if (Exit.isSuccess(exit)) return exit.value;
  const failureOption = Cause.failureOption(exit.cause);
  if (failureOption._tag === "Some") throw failureOption.value;
  throw new Error(Cause.pretty(exit.cause));
}

describe("spawnCaptureEffect — happy path", () => {
  test("captures stdout when process exits 0", async () => {
    const result = await run(
      "node",
      ["-e", "process.stdout.write('hello-world')"],
      {},
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello-world");
    expect(result.stderr).toBe("");
  });

  test("captures stderr when process exits 0", async () => {
    const result = await run(
      "node",
      ["-e", "process.stderr.write('warn'); process.exit(0)"],
      {},
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("warn");
  });

  test("captures non-zero exit codes without throwing", async () => {
    const result = await run("node", ["-e", "process.exit(7)"], {});
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe("");
  });

  test("non-zero exit surfaces stderr in result", async () => {
    const result = await run(
      "node",
      [
        "-e",
        "process.stderr.write('boom'); process.exit(2)",
      ],
      {},
    );
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
    const result = await run(
      "node",
      ["-e", `process.stderr.write(${JSON.stringify(partial)})`],
      {},
    );
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
    const result = await run(
      "node",
      [
        "-e",
        "const buf = 'A'.repeat(50_000); process.stdout.write(buf)",
      ],
      { maxOutputBytes: 1_000 },
    );
    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(1_000);
    expect(result.stdout.startsWith("A")).toBe(true);
  });

  test("stderr exceeding maxOutputBytes is truncated", async () => {
    const result = await run(
      "node",
      [
        "-e",
        "const buf = 'B'.repeat(50_000); process.stderr.write(buf)",
      ],
      { maxOutputBytes: 1_000 },
    );
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(1_000);
  });

  test("default maxOutputBytes (200KB) — output near-but-under cap not truncated", async () => {
    // 100 KB — well under 200 KB default
    const result = await run(
      "node",
      [
        "-e",
        "process.stdout.write('A'.repeat(100_000))",
      ],
      {},
    );
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
    await expect(
      run("node", ["-e", "setTimeout(() => {}, 10_000)"], { timeoutMs: 100 }),
    ).rejects.toMatchObject({
      code: "PROCESS_TIMEOUT",
    });
  });

  test("idle timeout fires with PROCESS_IDLE_TIMEOUT", async () => {
    await expect(
      run(
        "node",
        [
          "-e",
          "process.stdout.write('hi'); setTimeout(()=>{}, 10_000)",
        ],
        { idleTimeoutMs: 150 },
      ),
    ).rejects.toMatchObject({
      code: "PROCESS_IDLE_TIMEOUT",
    });
  });

  test("idle timer resets on stdout activity", async () => {
    // Process emits a tick every 50ms for ~250ms; idleTimeout 200ms.
    // It should never time out because each tick resets the idle timer.
    const result = await run(
      "sh",
      [
        "-c",
        "for i in 1 2 3 4 5; do echo tick; sleep 0.05; done",
      ],
      { idleTimeoutMs: 200 },
    );
    expect(result.stdout).toContain("tick");
    expect(result.exitCode).toBe(0);
  });

  test("abort signal already aborted: PROCESS_ABORTED", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      run("node", ["-e", "setTimeout(()=>{}, 5000)"], { signal: ac.signal }),
    ).rejects.toMatchObject({ code: "PROCESS_ABORTED" });
  });

  test("abort mid-run kills the process", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await expect(
      run(
        "node",
        ["-e", "setTimeout(()=>{ process.stdout.write('done') }, 5000)"],
        { signal: ac.signal },
      ),
    ).rejects.toMatchObject({ code: "PROCESS_ABORTED" });
  });
});

describe("spawnCaptureEffect — external kill / spawn errors", () => {
  test("process killed externally exits with null code, no throw", async () => {
    // Self-kill via SIGKILL — we treat this like an external kill since the
    // captor sees only the close event, not our intent.
    const result = await run(
      "node",
      [
        "-e",
        "process.kill(process.pid, 'SIGKILL')",
      ],
      {},
    );
    // Node returns null exit code when terminated by signal
    expect(result.exitCode === null || result.exitCode === 137).toBe(true);
  });

  test("non-existent command surfaces PROCESS_SPAWN_FAILED", async () => {
    await expect(
      run("/nonexistent/binary-does-not-exist", [], {}),
    ).rejects.toMatchObject({ code: "PROCESS_SPAWN_FAILED" });
  });
});

describe("spawnCaptureEffect — concurrency / fd hygiene", () => {
  test("spawns 20 cheap processes concurrently without leaking", async () => {
    const N = 20;
    const promises = Array.from({ length: N }, (_, i) =>
      run("node", ["-e", `process.stdout.write('p${i}')`], {}),
    );
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
      Array.from({ length: N }, () =>
        run("node", ["-e", "setTimeout(()=>{}, 10_000)"], { timeoutMs: 80 }),
      ),
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
      [
        "-e",
        "process.stdout.write('one'); setTimeout(()=>process.stdout.write('two'), 30)",
      ],
      { onStdout: (c) => chunks.push(c) },
    );
    expect(result.stdout).toBe("onetwo");
    expect(chunks.join("")).toBe("onetwo");
  });

  test("onStderr receives streamed chunks", async () => {
    const chunks = [];
    await run(
      "node",
      [
        "-e",
        "process.stderr.write('e1'); setTimeout(()=>process.stderr.write('e2'), 20)",
      ],
      { onStderr: (c) => chunks.push(c) },
    );
    expect(chunks.join("")).toBe("e1e2");
  });
});

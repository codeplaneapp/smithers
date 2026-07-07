import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Effect } from "effect";
import { runRpcCommandEffect } from "../src/BaseCliAgent/runRpcCommandEffect.js";

/**
 * A fake child process covering the surface runRpcCommandEffect touches. `pid`
 * lets a test exercise the process-group termination path; `stdin: false`
 * exercises the "stdin unavailable" settle.
 * @param {{ stdin?: boolean; pid?: number }} [opts]
 */
function makeFakeChild({ stdin = true, pid = undefined } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = stdin ? new PassThrough() : null;
  child.pid = pid;
  child.exitCode = null;
  child.unref = () => {};
  return child;
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("runRpcCommandEffect branches", () => {
  /** @type {(...args: any[]) => any} */
  let realKill;
  beforeEach(() => {
    // Never let a fake pid signal a real process group.
    realKill = process.kill;
    process.kill = /** @type {any} */ (() => true);
  });
  afterEach(() => {
    process.kill = realKill;
  });

  /**
   * @param {import("node:child_process").ChildProcess} child
   * @param {Record<string, unknown>} [extra]
   */
  function start(child, extra = {}) {
    const effect = runRpcCommandEffect("fake-cli", ["--x"], {
      cwd: process.cwd(),
      env: /** @type {any} */ ({}),
      prompt: "hello",
      spawnFn: /** @type {any} */ (() => child),
      ...extra,
    });
    return Effect.runPromise(effect);
  }

  test("finalizes a successful turn, tracking usage and terminating the group", async () => {
    const child = makeFakeChild({ pid: 4242 });
    const controller = new AbortController();
    /** @type {string[]} */
    const streamed = [];
    const promise = start(child, {
      signal: controller.signal,
      timeoutMs: 1_000_000,
      idleTimeoutMs: 1_000_000,
      onStdout: (t) => streamed.push(t),
      onJsonEvent: () => {},
    });
    await tick();
    // top-level usage event (extractedUsage assignment)
    child.stdout.write(JSON.stringify({ type: "note", usage: { input_tokens: 3 } }) + "\n");
    child.stdout.write(
      JSON.stringify({ type: "message_end", message: { role: "assistant" } }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final answer" }],
          usage: { output_tokens: 7 },
          stopReason: "stop",
        },
      }) + "\n",
    );
    await tick(60);
    // terminateChild schedules a SIGKILL timer that a close event clears.
    child.emit("close", 0);
    const result = await promise;
    expect(result.text).toBe("final answer");
    expect(result.usage).toEqual({ output_tokens: 7 });
    expect(streamed.join("")).toBe("final answer");
  });

  test("aborts immediately when the signal is already aborted", async () => {
    const child = makeFakeChild();
    const promise = start(child, { signal: AbortSignal.abort() });
    await expect(promise).rejects.toThrow(/CLI aborted/);
  });

  test("handles a signal that reports not-aborted then aborted (defensive recheck)", async () => {
    let reads = 0;
    const signal = /** @type {any} */ ({
      get aborted() {
        return reads++ > 0;
      },
      addEventListener() {},
      removeEventListener() {},
    });
    const child = makeFakeChild();
    const promise = start(child, { signal });
    await expect(promise).rejects.toThrow(/CLI aborted/);
  });

  test("aborts when a live signal fires after startup", async () => {
    const child = makeFakeChild();
    const controller = new AbortController();
    const promise = start(child, { signal: controller.signal });
    await tick();
    controller.abort();
    await expect(promise).rejects.toThrow(/CLI aborted/);
  });

  test("ignores unparseable lines and fails on a prompt-response error", async () => {
    const child = makeFakeChild();
    const promise = start(child);
    await tick();
    child.stdout.write("not-json{\n");
    child.stdout.write(
      JSON.stringify({ type: "response", command: "prompt", success: false, error: "prompt rejected" }) +
        "\n",
    );
    await expect(promise).rejects.toThrow(/prompt rejected/);
  });

  test("surfaces an assistant error stop reason from turn_end", async () => {
    const child = makeFakeChild();
    const promise = start(child);
    await tick();
    child.stdout.write(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "mid-turn boom" },
      }) + "\n",
    );
    child.stdout.write(
      JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", stopReason: "aborted", errorMessage: "turn boom" },
      }) + "\n",
    );
    await expect(promise).rejects.toThrow(/turn boom/);
  });

  test("truncates over-long stderr and finalizes via a clean close", async () => {
    const child = makeFakeChild();
    /** @type {string[]} */
    const stderrChunks = [];
    const promise = start(child, {
      maxOutputBytes: 8,
      onStderr: (t) => stderrChunks.push(t),
    });
    await tick();
    child.stderr.write("this is a very long stderr line well past the cap\n");
    await tick();
    child.stdout.write(
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "closed answer" }] } }) +
        "\n",
    );
    await tick();
    child.emit("close", 0);
    const result = await promise;
    expect(result.text).toBe("closed answer");
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(8);
    expect(stderrChunks.join("")).toContain("long stderr");
  });

  test("fails when the child emits an error event", async () => {
    const child = makeFakeChild();
    const promise = start(child);
    await tick();
    child.emit("error", new Error("spawn exploded"));
    await expect(promise).rejects.toThrow(/spawn exploded/);
  });

  test("fails on a non-zero close with the exit-code fallback message", async () => {
    const child = makeFakeChild();
    const promise = start(child);
    await tick();
    child.emit("close", 5);
    await expect(promise).rejects.toThrow(/CLI exited with code 5/);
  });

  test("cancels an extension UI request with no handler and finalizes", async () => {
    const child = makeFakeChild();
    const promise = start(child);
    await tick();
    // A non-blocking method with no handler is a no-op early return.
    child.stdout.write(JSON.stringify({ type: "extension_ui_request", method: "notify", id: "n1" }) + "\n");
    // A blocking method with no handler auto-cancels (writes a cancelled response).
    child.stdout.write(JSON.stringify({ type: "extension_ui_request", method: "select", id: "s1" }) + "\n");
    await tick();
    child.stdout.write(
      JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "ext done" }] } }) +
        "\n",
    );
    const result = await promise;
    expect(result.text).toBe("ext done");
  });

  test("errors when an extension response cannot be sent (stdin gone)", async () => {
    const child = makeFakeChild();
    const promise = start(child, {
      onExtensionUiRequest: () => ({ type: "extension_ui_response", value: "x" }),
    });
    await tick();
    // Drop stdin after the prompt was already written, then request UI.
    child.stdin = null;
    child.stdout.write(JSON.stringify({ type: "extension_ui_request", method: "input", id: "i1" }) + "\n");
    await expect(promise).rejects.toThrow(/stdin is not available/);
  });

  test("settles as an error when child stdin is unavailable at prompt time", async () => {
    const child = makeFakeChild({ stdin: false });
    await expect(start(child)).rejects.toThrow(/stdin is not available/);
  });

  test("runs the interrupt finalizer when the effect is timed out", async () => {
    const child = makeFakeChild({ pid: 5252 });
    const controller = new AbortController();
    const effect = runRpcCommandEffect("fake-cli", [], {
      cwd: process.cwd(),
      env: /** @type {any} */ ({}),
      prompt: "hello",
      signal: controller.signal,
      spawnFn: /** @type {any} */ (() => child),
    });
    // The child never closes, so the total timeout interrupts the fiber and
    // runs the acquireRelease finalizer (rl.close + removeEventListener + kill).
    await expect(
      Effect.runPromise(Effect.timeout(effect, "80 millis")),
    ).rejects.toThrow();
  });

  test("kills the child when the idle timer fires", async () => {
    const child = makeFakeChild();
    const promise = start(child, { idleTimeoutMs: 40 });
    // No stdout activity, so the inactivity timer fires and kills the run.
    await expect(promise).rejects.toThrow(/idle timed out/);
  });

  test("streams assistant text deltas and finalizes on a clean close", async () => {
    const child = makeFakeChild();
    /** @type {string[]} */
    const streamed = [];
    const promise = start(child, { onStdout: (t) => streamed.push(t) });
    await tick();
    child.stdout.write(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hel" } }) +
        "\n",
    );
    child.stdout.write(
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo" } }) +
        "\n",
    );
    await tick();
    child.emit("close", 0);
    const result = await promise;
    expect(result.text).toBe("hello");
    expect(streamed.join("")).toBe("hello");
  });

  test("routes a throwing line handler through the queue's catch", async () => {
    const child = makeFakeChild();
    const promise = start(child, {
      onExtensionUiRequest: () => {
        throw new Error("handler boom");
      },
    });
    await tick();
    child.stdout.write(JSON.stringify({ type: "extension_ui_request", method: "select", id: "x1" }) + "\n");
    await expect(promise).rejects.toThrow(/handler boom/);
  });

  test("fails on close when an earlier message flagged a prompt error", async () => {
    const child = makeFakeChild();
    const promise = start(child);
    await tick();
    child.stdout.write(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "flagged boom" },
      }) + "\n",
    );
    await tick();
    child.emit("close", 0);
    await expect(promise).rejects.toThrow(/flagged boom/);
  });

  test("fires the delayed SIGKILL when no close clears the terminate timer", async () => {
    const child = makeFakeChild({ pid: 7777 });
    const promise = start(child, { idleTimeoutMs: 30 });
    await expect(promise).rejects.toThrow(/idle timed out/);
    // The idle kill scheduled a 250ms SIGKILL fallback; with no close event it
    // fires here (process.kill is stubbed for the whole describe block).
    await tick(300);
  });
});

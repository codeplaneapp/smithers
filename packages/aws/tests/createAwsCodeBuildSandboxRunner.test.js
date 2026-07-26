import { describe, expect, test } from "bun:test";
import { createAwsCodeBuildSandboxRunner } from "../src/createAwsCodeBuildSandboxRunner.js";

/**
 * Build an injected CodeBuild client double whose behavior each test tunes.
 * @param {{
 *   startBuild?: (input: any) => Promise<any> | any;
 *   batchGetBuilds?: (input: any) => Promise<any> | any;
 * }} [overrides]
 */
function codebuildDouble(overrides = {}) {
  /** @type {string[]} */
  const stoppedIds = [];
  /** @type {(AbortSignal | undefined)[]} */
  const stopSignals = [];
  const client = {
    startBuild: overrides.startBuild ?? (async () => ({ build: { id: "build-1", buildStatus: "IN_PROGRESS" } })),
    batchGetBuilds:
      overrides.batchGetBuilds ?? (async () => ({ builds: [{ id: "build-1", buildStatus: "SUCCEEDED" }] })),
    /** @param {{ id: string }} input */
    async stopBuild(input, handlerOptions) {
      stoppedIds.push(String(input.id));
      stopSignals.push(handlerOptions?.abortSignal);
      return {};
    },
  };
  return { client, stoppedIds, stopSignals };
}

const BASE = { projectName: "smithers-sandbox", bucket: "b", prefix: "smithers/sandbox/run/sbx" };

describe("createAwsCodeBuildSandboxRunner — validation & launch", () => {
  test("requires a projectName", async () => {
    await expect(createAwsCodeBuildSandboxRunner({ ...BASE, projectName: "  " })).rejects.toThrow(/projectName/);
  });

  test("throws when the signal is already aborted before launch", async () => {
    const { client } = codebuildDouble();
    const runner = await createAwsCodeBuildSandboxRunner({ ...BASE, client });
    const controller = new AbortController();
    controller.abort();
    await expect(runner.run("echo hi", { env: {}, timeoutMs: 1000, signal: controller.signal })).rejects.toThrow(
      /cancelled before launch/,
    );
  });

  test("StartBuild failure is surfaced with secrets scrubbed", async () => {
    const { client } = codebuildDouble({
      startBuild: async () => {
        throw new Error("access denied for TOKENVAL");
      },
    });
    const runner = await createAwsCodeBuildSandboxRunner({ ...BASE, client, secrets: ["TOKENVAL"] });
    let message = "";
    try {
      await runner.run("echo hi", { env: {}, timeoutMs: 1000 });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/StartBuild failed/);
    expect(message).not.toContain("TOKENVAL");
  });

  test("throws when StartBuild returns no build id", async () => {
    const { client } = codebuildDouble({ startBuild: async () => ({ build: {} }) });
    const runner = await createAwsCodeBuildSandboxRunner({ ...BASE, client });
    await expect(runner.run("echo hi", { env: {}, timeoutMs: 1000 })).rejects.toThrow(/returned no build id/);
  });

  test("aborting a pending StartBuild request rejects promptly", async () => {
    const controller = new AbortController();
    let launchSignal;
    const { client, stoppedIds } = codebuildDouble({
      startBuild: (_input, handlerOptions) => {
        launchSignal = handlerOptions?.abortSignal;
        return new Promise((_, reject) => {
          launchSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true,
          });
        });
      },
    });
    const runner = await createAwsCodeBuildSandboxRunner({ ...BASE, client });
    const pending = runner.run("echo hi", { env: {}, timeoutMs: 60_000, signal: controller.signal });
    expect(launchSignal).toBe(controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled before launch/);
    expect(stoppedIds).toEqual([]);
  });
});

describe("createAwsCodeBuildSandboxRunner — polling", () => {
  test("captureLogs reads CloudWatch output and maps SUCCEEDED to exit 0", async () => {
    const { client } = codebuildDouble({
      batchGetBuilds: async () => ({
        builds: [{ id: "build-1", buildStatus: "SUCCEEDED", logs: { groupName: "/g", streamName: "s" } }],
      }),
    });
    const logs = { getLogEvents: async () => ({ events: [{ message: "line-one\n" }, { message: "line-two" }] }) };
    const runner = await createAwsCodeBuildSandboxRunner({ ...BASE, client, captureLogs: true, logs });
    const res = await runner.run("echo hi", { env: {}, timeoutMs: 60_000 });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("line-one\nline-two");
    expect(res.stderr).toBe("");
    expect(runner.remoteId).toBe("build-1");
  });

  test("non-SUCCEEDED status maps to exit 1 and scrubs the status into stderr", async () => {
    const { client } = codebuildDouble({
      batchGetBuilds: async () => ({ builds: [{ id: "build-1", buildStatus: "FAILED" }] }),
    });
    const runner = await createAwsCodeBuildSandboxRunner({ ...BASE, client });
    const res = await runner.run("echo hi", { env: {}, timeoutMs: 60_000 });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toBe("FAILED");
  });

  test("sleeps between IN_PROGRESS polls (signal present) then completes", async () => {
    let calls = 0;
    const { client } = codebuildDouble({
      batchGetBuilds: async () => {
        calls += 1;
        return { builds: [{ id: "build-1", buildStatus: calls < 2 ? "IN_PROGRESS" : "SUCCEEDED" }] };
      },
    });
    const runner = await createAwsCodeBuildSandboxRunner({ ...BASE, client });
    const controller = new AbortController();
    const res = await runner.run("echo hi", { env: {}, timeoutMs: 60_000, signal: controller.signal });
    expect(res.exitCode).toBe(0);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("times out when the build never leaves IN_PROGRESS, and stops the build", async () => {
    const { client, stoppedIds, stopSignals } = codebuildDouble({
      batchGetBuilds: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { builds: [{ id: "build-1", buildStatus: "IN_PROGRESS" }] };
      },
    });
    const runner = await createAwsCodeBuildSandboxRunner({ ...BASE, client });
    const controller = new AbortController();
    await expect(runner.run("echo hi", { env: {}, timeoutMs: 1, signal: controller.signal })).rejects.toThrow(
      /did not finish within/,
    );
    expect(stoppedIds).toEqual(["build-1"]);
    expect(stopSignals).toEqual([controller.signal]);
  });

  test("aborting a pending BatchGetBuilds request rejects and cleans up exactly once", async () => {
    const controller = new AbortController();
    const pollStarted = Promise.withResolvers();
    let pollSignal;
    const { client, stoppedIds } = codebuildDouble({
      batchGetBuilds: (_input, handlerOptions) => {
        pollSignal = handlerOptions?.abortSignal;
        pollStarted.resolve();
        return new Promise((_, reject) => {
          pollSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true,
          });
        });
      },
    });
    const runner = await createAwsCodeBuildSandboxRunner({ ...BASE, client });
    const pending = runner.run("echo hi", { env: {}, timeoutMs: 60_000, signal: controller.signal });
    await pollStarted.promise;
    expect(pollSignal).toBe(controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(stoppedIds).toEqual(["build-1"]);
    await runner.stop();
    expect(stoppedIds).toEqual(["build-1"]);
  });

  test("aborting during a poll sleep cancels the build", async () => {
    const controller = new AbortController();
    const { client, stoppedIds } = codebuildDouble({
      batchGetBuilds: async () => {
        setTimeout(() => controller.abort(), 0);
        return { builds: [{ id: "build-1", buildStatus: "IN_PROGRESS" }] };
      },
    });
    const runner = await createAwsCodeBuildSandboxRunner({ ...BASE, client });
    await expect(runner.run("echo hi", { env: {}, timeoutMs: 60_000, signal: controller.signal })).rejects.toThrow(
      /cancelled/,
    );
    expect(stoppedIds).toEqual(["build-1"]);
  });

  test("an abort observed at the top of a poll iteration cancels the build", async () => {
    const controller = new AbortController();
    let calls = 0;
    const { client, stoppedIds } = codebuildDouble({
      batchGetBuilds: async () => {
        calls += 1;
        // Abort synchronously so the abort is only observed at the next loop top
        // (the sleep sees an already-aborted signal and never fires its listener).
        if (calls === 1) controller.abort();
        return { builds: [{ id: "build-1", buildStatus: "IN_PROGRESS" }] };
      },
    });
    const runner = await createAwsCodeBuildSandboxRunner({ ...BASE, client });
    await expect(runner.run("echo hi", { env: {}, timeoutMs: 60_000, signal: controller.signal })).rejects.toThrow(
      /cancelled/,
    );
    expect(stoppedIds).toEqual(["build-1"]);
  });
});

import { describe, expect, test } from "bun:test";
import { createAwsEcsSandboxRunner } from "../src/createAwsEcsSandboxRunner.js";

/**
 * Build an injected ECS client double whose behavior each test tunes.
 * @param {{
 *   runTask?: (input: any) => Promise<any> | any;
 *   describeTasks?: (input: any) => Promise<any> | any;
 * }} [overrides]
 */
function ecsDouble(overrides = {}) {
  /** @type {string[]} */
  const stoppedTasks = [];
  /** @type {(AbortSignal | undefined)[]} */
  const stopSignals = [];
  const client = {
    runTask: overrides.runTask ?? (async () => ({ tasks: [{ taskArn: "arn:task/1" }], failures: [] })),
    describeTasks:
      overrides.describeTasks ??
      (async () => ({
        tasks: [{ taskArn: "arn:task/1", lastStatus: "STOPPED", containers: [{ name: "runner", exitCode: 0 }] }],
      })),
    /** @param {{ task: string }} input */
    async stopTask(input, handlerOptions) {
      stoppedTasks.push(String(input.task));
      stopSignals.push(handlerOptions?.abortSignal);
      return {};
    },
  };
  return { client, stoppedTasks, stopSignals };
}

const BASE = {
  cluster: "smithers",
  taskDefinition: "smithers-sandbox:1",
  subnets: ["subnet-a"],
  containerName: "runner",
};

describe("createAwsEcsSandboxRunner — validation", () => {
  test("requires cluster/taskDefinition/subnets/containerName", async () => {
    const { client } = ecsDouble();
    await expect(createAwsEcsSandboxRunner({ ...BASE, client, cluster: "  " })).rejects.toThrow(/cluster/);
    await expect(createAwsEcsSandboxRunner({ ...BASE, client, taskDefinition: "" })).rejects.toThrow(/taskDefinition/);
    await expect(createAwsEcsSandboxRunner({ ...BASE, client, subnets: [] })).rejects.toThrow(/subnets/);
    await expect(createAwsEcsSandboxRunner({ ...BASE, client, containerName: "" })).rejects.toThrow(/containerName/);
  });

  test("RunTask returning no task surfaces the scrubbed failure reason", async () => {
    const { client } = ecsDouble({
      runTask: async () => ({ tasks: [], failures: [{ reason: "Capacity SEKRET unavailable" }] }),
    });
    const runner = await createAwsEcsSandboxRunner({ ...BASE, client, secrets: ["SEKRET"] });
    let message = "";
    try {
      await runner.run("echo hi", { env: {}, timeoutMs: 1000 });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/RunTask returned no task/);
    expect(message).not.toContain("SEKRET");
  });

  test("aborting a pending RunTask request rejects promptly", async () => {
    const controller = new AbortController();
    let launchSignal;
    const { client, stoppedTasks } = ecsDouble({
      runTask: (_input, handlerOptions) => {
        launchSignal = handlerOptions?.abortSignal;
        return new Promise((_, reject) => {
          launchSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true,
          });
        });
      },
    });
    const runner = await createAwsEcsSandboxRunner({ ...BASE, client });
    const pending = runner.run("echo hi", { env: {}, timeoutMs: 60_000, signal: controller.signal });
    expect(launchSignal).toBe(controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled before launch/);
    expect(stoppedTasks).toEqual([]);
  });
});

describe("createAwsEcsSandboxRunner — polling", () => {
  test("sleeps between non-STOPPED polls (signal present) then returns the container exit code", async () => {
    let calls = 0;
    const { client } = ecsDouble({
      describeTasks: async () => {
        calls += 1;
        return calls < 2
          ? { tasks: [{ taskArn: "arn:task/1", lastStatus: "RUNNING", containers: [] }] }
          : {
              tasks: [{ taskArn: "arn:task/1", lastStatus: "STOPPED", containers: [{ name: "runner", exitCode: 0 }] }],
            };
      },
    });
    const runner = await createAwsEcsSandboxRunner({ ...BASE, client });
    const controller = new AbortController();
    const res = await runner.run("echo hi", { env: {}, timeoutMs: 60_000, signal: controller.signal });
    expect(res.exitCode).toBe(0);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(runner.remoteId).toBe("arn:task/1");
  });

  test("times out when the task never stops, and issues a StopTask", async () => {
    const { client, stoppedTasks, stopSignals } = ecsDouble({
      describeTasks: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { tasks: [{ taskArn: "arn:task/1", lastStatus: "RUNNING", containers: [] }] };
      },
    });
    const runner = await createAwsEcsSandboxRunner({ ...BASE, client });
    const controller = new AbortController();
    await expect(runner.run("echo hi", { env: {}, timeoutMs: 1, signal: controller.signal })).rejects.toThrow(
      /did not stop within/,
    );
    expect(stoppedTasks).toEqual(["arn:task/1"]);
    expect(stopSignals).toEqual([controller.signal]);
  });

  test("aborting a pending DescribeTasks request rejects and cleans up exactly once", async () => {
    const controller = new AbortController();
    const pollStarted = Promise.withResolvers();
    let pollSignal;
    const { client, stoppedTasks } = ecsDouble({
      describeTasks: (_input, handlerOptions) => {
        pollSignal = handlerOptions?.abortSignal;
        pollStarted.resolve();
        return new Promise((_, reject) => {
          pollSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true,
          });
        });
      },
    });
    const runner = await createAwsEcsSandboxRunner({ ...BASE, client });
    const pending = runner.run("echo hi", { env: {}, timeoutMs: 60_000, signal: controller.signal });
    await pollStarted.promise;
    expect(pollSignal).toBe(controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(stoppedTasks).toEqual(["arn:task/1"]);
    await runner.stop();
    expect(stoppedTasks).toEqual(["arn:task/1"]);
  });

  test("aborting during a poll sleep cancels the task", async () => {
    const controller = new AbortController();
    const { client, stoppedTasks } = ecsDouble({
      describeTasks: async () => {
        setTimeout(() => controller.abort(), 0);
        return { tasks: [{ taskArn: "arn:task/1", lastStatus: "RUNNING", containers: [] }] };
      },
    });
    const runner = await createAwsEcsSandboxRunner({ ...BASE, client });
    await expect(runner.run("echo hi", { env: {}, timeoutMs: 60_000, signal: controller.signal })).rejects.toThrow(
      /cancelled/,
    );
    expect(stoppedTasks).toEqual(["arn:task/1"]);
  });

  test("an abort observed at the top of a poll iteration cancels the task", async () => {
    const controller = new AbortController();
    let calls = 0;
    const { client, stoppedTasks } = ecsDouble({
      describeTasks: async () => {
        calls += 1;
        if (calls === 1) controller.abort();
        return { tasks: [{ taskArn: "arn:task/1", lastStatus: "RUNNING", containers: [] }] };
      },
    });
    const runner = await createAwsEcsSandboxRunner({ ...BASE, client });
    await expect(runner.run("echo hi", { env: {}, timeoutMs: 60_000, signal: controller.signal })).rejects.toThrow(
      /cancelled/,
    );
    expect(stoppedTasks).toEqual(["arn:task/1"]);
  });
});

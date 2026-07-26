import { describe, expect, test } from "bun:test";
import { createCloudflareSandboxProvider, createMockCloudflareSandboxEnvironment } from "../src/index.js";

describe("createCloudflareSandboxProvider", () => {
  test("executes a Smithers sandbox request in a Cloudflare sandbox", async () => {
    const env = createMockCloudflareSandboxEnvironment(async ({ command, request, files }) => {
      expect(command).toBe("node /workspace/run.js");
      expect(request).toMatchObject({
        runId: "run-1",
        sandboxId: "sandbox-1",
        input: { topic: "cloudflare" },
      });
      expect([...files.keys()].some((path) => path.endsWith("sandbox-request.json"))).toBe(true);
      return { status: "finished", output: { ok: true } };
    });
    const provider = createCloudflareSandboxProvider({
      binding: env.binding,
      getSandbox: env.getSandbox,
      command: "node /workspace/run.js",
    });
    const heartbeats = [];
    const result = await provider.run({
      runId: "run-1",
      sandboxId: "sandbox-1",
      input: { topic: "cloudflare" },
      rootDir: "/tmp",
      requestBundlePath: "/tmp/request",
      resultBundlePath: "/tmp/result",
      workflow: { build: () => null },
      executeChildWorkflow: async () => ({ runId: "child", status: "finished", output: null }),
      allowNetwork: true,
      maxOutputBytes: 1024,
      toolTimeoutMs: 10_000,
      config: {},
      heartbeat: (data) => heartbeats.push(data),
    });

    expect(result).toEqual({
      status: "finished",
      output: { ok: true },
      remoteRunId: "run-1-sandbox-1",
      workspaceId: "run-1-sandbox-1",
      containerId: "run-1-sandbox-1",
    });
    expect(heartbeats[0]).toMatchObject({
      stage: "cloudflare-sandbox-created",
      remoteSandboxId: "run-1-sandbox-1",
    });

    await provider.cleanup?.({
      runId: "run-1",
      sandboxId: "sandbox-1",
      rootDir: "/tmp",
      requestBundlePath: "/tmp/request",
      resultBundlePath: "/tmp/result",
      workflow: { build: () => null },
      executeChildWorkflow: async () => ({ runId: "child", status: "finished", output: null }),
      allowNetwork: true,
      maxOutputBytes: 1024,
      toolTimeoutMs: 10_000,
      config: {},
      heartbeat: () => {},
    });
    expect(env.sandboxes.get("run-1-sandbox-1").destroyed).toBe(true);
  });

  test("process mode waits for the process to exit and reconciles the result bundle", async () => {
    const env = createMockCloudflareSandboxEnvironment(async ({ command }) => {
      expect(command).toBe("bun run worker.ts");
      return { status: "finished", output: { trained: true } };
    });
    const provider = createCloudflareSandboxProvider({
      binding: env.binding,
      getSandbox: env.getSandbox,
      execution: "process",
      command: "bun run worker.ts",
      cleanup: "keep",
    });
    const heartbeats = [];
    const result = await provider.run({
      runId: "run-2",
      sandboxId: "worker",
      rootDir: "/tmp",
      requestBundlePath: "/tmp/request",
      resultBundlePath: "/tmp/result",
      workflow: { build: () => null },
      executeChildWorkflow: async () => ({ runId: "child", status: "finished", output: null }),
      allowNetwork: true,
      maxOutputBytes: 1024,
      toolTimeoutMs: 10_000,
      config: {},
      heartbeat: (data) => heartbeats.push(data),
    });
    // Not a bare pid: the detached process is awaited and its result bundle
    // reconciled, with the remote identifiers stamped (regression: process
    // mode used to fire-and-forget and return only a pid).
    expect(result).toEqual({
      status: "finished",
      output: { trained: true },
      remoteRunId: "run-2-worker",
      workspaceId: "run-2-worker",
      containerId: "run-2-worker",
    });
    expect(heartbeats.some((h) => h?.stage === "cloudflare-sandbox-process-started")).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { MICROSANDBOX_PROVIDER_ID } from "../src/MICROSANDBOX_PROVIDER_ID.js";
import { createMicrosandboxSandboxProvider } from "../src/createMicrosandboxSandboxProvider.js";
import { createMockMicrosandboxEnvironment } from "./fixtures/createMockMicrosandboxEnvironment.js";

let requestSeq = 0;

/** @param {Record<string, unknown>} [overrides] */
function makeRequest(overrides = {}) {
  const seq = requestSeq++;
  const heartbeats = [];
  const request = {
    runId: `run-${seq}`,
    sandboxId: "worker",
    input: { topic: "microsandbox" },
    config: {},
    rootDir: `/tmp/microsandbox-${seq}/root`,
    requestBundlePath: `/tmp/microsandbox-${seq}/request`,
    resultBundlePath: `/tmp/microsandbox-${seq}/result`,
    workflow: { build: () => null },
    executeChildWorkflow: async () => ({ runId: "child", status: "finished", output: null }),
    allowNetwork: false,
    maxOutputBytes: 1_000_000,
    toolTimeoutMs: 30_000,
    heartbeat: (data) => heartbeats.push(data),
    ...overrides,
  };
  return { request, heartbeats };
}

describe("createMicrosandboxSandboxProvider", () => {
  test("uses the default and custom provider ids", () => {
    const sdk = createMockMicrosandboxEnvironment(() => ({ status: "finished" }));
    expect(createMicrosandboxSandboxProvider({ sdk }).id).toBe(MICROSANDBOX_PROVIDER_ID);
    expect(createMicrosandboxSandboxProvider({ id: "local-vm", sdk }).id).toBe("local-vm");
  });

  test("maps standard Sandbox controls and provider options onto the SDK", async () => {
    let exec;
    const sdk = createMockMicrosandboxEnvironment((args) => {
      exec = args;
      return { status: "finished", output: { ok: true } };
    });
    const provider = createMicrosandboxSandboxProvider({
      sdk,
      cpus: 1,
      memoryMib: 512,
      maxCpus: 4,
      maxMemoryMib: 8192,
      security: "restricted",
      pullPolicy: "if-not-present",
      labels: { owner: "smithers" },
      scripts: { prepare: "#!/bin/sh\necho ready" },
      setupFiles: { "/workspace/run-smithers-sandbox.js": "runner" },
      maxDurationSecs: 900,
    });
    const { request } = makeRequest({
      allowNetwork: true,
      config: {
        image: "node:22-bookworm",
        command: "run-child --json",
        env: { REQUEST_FLAG: "request" },
        ports: [{ host: 3210, container: 3000 }],
        volumes: [{ host: "/tmp/cache", container: "/cache", readonly: false }],
        memoryLimit: "4g",
        cpuLimit: "1.5",
        workspace: { name: "job", idleTimeoutSecs: 120, persistence: "ephemeral" },
      },
    });

    const result = await provider.run(request);
    expect(result.status).toBe("finished");
    expect(sdk.createConfigs).toHaveLength(1);
    const config = sdk.createConfigs[0];
    expect(config.image).toBe("node:22-bookworm");
    expect(config.cpus).toBe(2);
    expect(config.memoryMib).toBe(4096);
    expect(config.maxCpus).toBe(4);
    expect(config.maxMemoryMib).toBe(8192);
    // The provider creates /workspace after boot. Passing it to the vendor
    // builder would fail when the image does not already contain that path.
    expect(config.workdir).toBeUndefined();
    expect(config.security).toBe("restricted");
    expect(config.pullPolicy).toBe("if-not-present");
    expect(config.labels).toEqual({ owner: "smithers" });
    expect(config.scripts).toEqual({ prepare: "#!/bin/sh\necho ready" });
    expect(config.ports).toEqual([{ host: 3210, guest: 3000 }]);
    expect(config.volumes).toEqual([{ guest: "/cache", host: "/tmp/cache", readonly: false }]);
    expect(config.idleTimeoutSecs).toBe(120);
    expect(config.maxDurationSecs).toBe(900);
    expect(config.networkDisabled).toBeUndefined();
    expect(exec.command).toBe("run-child --json");
    expect(exec.env.REQUEST_FLAG).toBe("request");
    const sandbox = [...sdk.sandboxes.values()][0];
    expect(sandbox.directories.has("/workspace")).toBe(true);
    expect(sandbox.files.get("/workspace/run-smithers-sandbox.js")).toBe("runner");

    await provider.cleanup(request);
    expect(sdk.sandboxes.size).toBe(0);
  });

  test("factory command and env override request config", async () => {
    let exec;
    const sdk = createMockMicrosandboxEnvironment((args) => {
      exec = args;
      return { status: "finished" };
    });
    const provider = createMicrosandboxSandboxProvider({
      sdk,
      command: "factory-command",
      env: { FLAG: "factory", BASELINE: "yes" },
    });
    const { request } = makeRequest({
      config: { command: "request-command", env: { FLAG: "request", REQUEST_ONLY: "yes" } },
    });
    await provider.run(request);
    expect(exec.command).toBe("factory-command");
    expect(exec.env).toMatchObject({ FLAG: "factory", BASELINE: "yes", REQUEST_ONLY: "yes" });
    await provider.cleanup(request);
  });

  test("disables networking when allowNetwork is false", async () => {
    const sdk = createMockMicrosandboxEnvironment(() => ({ status: "finished" }));
    const provider = createMicrosandboxSandboxProvider({ sdk });
    const { request } = makeRequest();
    await provider.run(request);
    expect(sdk.createConfigs[0].networkDisabled).toBe(true);
    await provider.cleanup(request);
  });

  test("rejects ports without network access", async () => {
    const sdk = createMockMicrosandboxEnvironment(() => ({ status: "finished" }));
    const provider = createMicrosandboxSandboxProvider({ sdk });
    const { request } = makeRequest({ config: { ports: [{ host: 3000, container: 3000 }] } });
    await expect(provider.run(request)).rejects.toThrow(/requires allowNetwork=true/);
    expect(sdk.createConfigs).toHaveLength(0);
  });

  test("rejects a volume that shadows the provider workdir", async () => {
    const sdk = createMockMicrosandboxEnvironment(() => ({ status: "finished" }));
    const provider = createMicrosandboxSandboxProvider({ sdk });
    const { request } = makeRequest({ config: { volumes: [{ host: "/tmp/repo", container: "/workspace" }] } });
    await expect(provider.run(request)).rejects.toThrow(/may not overlap/);
  });

  test("boots from a workspace snapshot instead of the image", async () => {
    const sdk = createMockMicrosandboxEnvironment(() => ({ status: "finished" }));
    const provider = createMicrosandboxSandboxProvider({ sdk, image: "ignored" });
    const { request } = makeRequest({
      config: { workspace: { name: "snap", snapshotId: "baseline", persistence: "ephemeral" } },
    });
    await provider.run(request);
    expect(sdk.createConfigs[0].snapshot).toBe("baseline");
    expect(sdk.createConfigs[0].image).toBeUndefined();
    await provider.cleanup(request);
  });

  test("reopens a stopped sticky workspace without recreating it", async () => {
    let executions = 0;
    const sdk = createMockMicrosandboxEnvironment(() => {
      executions += 1;
      return { status: "finished", output: executions };
    });
    const provider = createMicrosandboxSandboxProvider({ sdk });
    const first = makeRequest({
      runId: "sticky-run-1",
      config: { workspace: { name: "sticky-project", persistence: "sticky" } },
    }).request;
    await provider.run(first);
    await provider.cleanup(first);
    expect(sdk.sandboxes.get("sticky-project").status).toBe("stopped");

    const second = makeRequest({
      runId: "sticky-run-2",
      config: { workspace: { name: "sticky-project", persistence: "sticky" } },
    }).request;
    await provider.run(second);
    await provider.cleanup(second);
    expect(sdk.createConfigs).toHaveLength(1);
    expect(executions).toBe(2);
    expect(sdk.sandboxes.get("sticky-project").status).toBe("stopped");
  });

  test("cleanup keep creates detached and leaves the sandbox running", async () => {
    const sdk = createMockMicrosandboxEnvironment(() => ({ status: "finished" }));
    const provider = createMicrosandboxSandboxProvider({ sdk, cleanup: "keep" });
    const { request } = makeRequest();
    await provider.run(request);
    await provider.cleanup(request);
    expect(sdk.createConfigs[0].detached).toBe(true);
    expect(sdk.createConfigs[0].ephemeral).toBe(false);
    expect([...sdk.sandboxes.values()][0].status).toBe("running");
  });

  test("aborting a command kills the guest process", async () => {
    const controller = new AbortController();
    const sdk = createMockMicrosandboxEnvironment(() => ({ status: "finished" }), {
      hangExec: true,
      onExec: () => controller.abort(),
    });
    const provider = createMicrosandboxSandboxProvider({ sdk });
    const { request } = makeRequest({ signal: controller.signal });
    await expect(provider.run(request)).rejects.toThrow(/aborted/);
    await provider.cleanup(request);
  });

  test("redacts secret env values from create and exec failures", async () => {
    const createSdk = createMockMicrosandboxEnvironment(() => ({ status: "finished" }), { failCreate: true });
    const createProvider = createMicrosandboxSandboxProvider({ sdk: createSdk, env: { SERVICE_TOKEN: "secret" } });
    const createRequest = makeRequest().request;
    try {
      await createProvider.run(createRequest);
      throw new Error("expected create failure");
    } catch (error) {
      expect(String(error)).not.toContain("SERVICE_TOKEN=secret");
      expect(String(error)).toContain("[redacted]");
    }

    const execSdk = createMockMicrosandboxEnvironment(() => ({ status: "finished" }), { failExec: true });
    const execProvider = createMicrosandboxSandboxProvider({ sdk: execSdk, env: { SERVICE_TOKEN: "secret" } });
    const execRequest = makeRequest().request;
    try {
      await execProvider.run(execRequest);
      throw new Error("expected exec failure");
    } catch (error) {
      expect(String(error)).not.toContain("SERVICE_TOKEN=secret");
      expect(String(error)).toContain("[redacted]");
    }
    await execProvider.cleanup(execRequest);
  });

  test("surfaces an actionable optional SDK error", async () => {
    const provider = createMicrosandboxSandboxProvider({
      importSdk: async () => {
        throw new Error("missing module");
      },
    });
    await expect(provider.run(makeRequest().request)).rejects.toThrow(/npm install microsandbox@0\.6\.6/);
  });

  test("rejects an SDK module without the Sandbox API", async () => {
    const provider = createMicrosandboxSandboxProvider({ importSdk: async () => ({}) });
    await expect(provider.run(makeRequest().request)).rejects.toThrow(/expected Sandbox API/);
  });

  test("wraps cleanup failures with the provider and remote id", async () => {
    const sdk = createMockMicrosandboxEnvironment(() => ({ status: "finished" }), { failStop: true });
    const provider = createMicrosandboxSandboxProvider({ sdk });
    const { request } = makeRequest();
    await provider.run(request);
    await expect(provider.cleanup(request)).rejects.toMatchObject({
      code: "SANDBOX_EXECUTION_FAILED",
      details: expect.objectContaining({ provider: "microsandbox" }),
    });
  });

  test("sanitizes and bounds derived SDK names", async () => {
    const sdk = createMockMicrosandboxEnvironment(() => ({ status: "finished" }));
    const provider = createMicrosandboxSandboxProvider({ sdk });
    const { request } = makeRequest({
      runId: `run with spaces/${"x".repeat(160)}`,
      sandboxId: "worker:1",
    });
    await provider.run(request);
    const name = sdk.createConfigs[0].name;
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(128);
    expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    await provider.cleanup(request);
  });

  test("validates factory options before opening the SDK", () => {
    const cases = [
      { image: "node", snapshot: "snap" },
      { workdir: "relative" },
      { shell: "sh" },
      { cpus: 0 },
      { memoryMib: 1.5 },
      { maxDurationSecs: 0 },
      { idleTimeoutSecs: -1 },
      { creationTimeoutMs: Number.NaN },
      { setupFiles: { "relative.js": "x" } },
    ];
    for (const options of cases) {
      expect(() => createMicrosandboxSandboxProvider(options)).toThrow(SmithersError);
    }
  });
});

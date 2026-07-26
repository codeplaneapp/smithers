import { describe, expect, test } from "bun:test";
import { createGcpSandboxProvider } from "../src/createGcpSandboxProvider.js";
import { createMockGcpSandboxEnvironment } from "../src/createMockGcpSandboxEnvironment.js";

const REQUIRED = { projectId: "p", location: "us-central1", bucket: "b", jobName: "j" };

let seq = 0;
function makeRequest(overrides = {}) {
  const n = seq++;
  return {
    runId: overrides.runId ?? `run-${n}`,
    sandboxId: overrides.sandboxId ?? `sbx-${n}`,
    input: overrides.input ?? { topic: "gcp" },
    config: overrides.config ?? { command: "echo hi" },
    rootDir: `/tmp/gcp-${n}/root`,
    requestBundlePath: `/tmp/gcp-${n}/request`,
    resultBundlePath: `/tmp/gcp-${n}/result`,
    workflow: /** @type {never} */ ({ build: () => null }),
    executeChildWorkflow: async () => ({ runId: "child", status: "finished", output: null }),
    allowNetwork: false,
    maxOutputBytes: 1_000_000,
    toolTimeoutMs: 30_000,
    heartbeat: () => {},
  };
}

describe("createGcpSandboxProvider SDK resolution", () => {
  test("lazy-imports both SDKs and constructs the clients when none are injected", async () => {
    // The injectable importers stand in for the real dynamic imports so the
    // success construction path (typeof-function check + `new Storage`/`new
    // JobsClient`) runs deterministically without GCP creds. The constructors
    // return the in-memory doubles so the whole run completes.
    const env = createMockGcpSandboxEnvironment(() => ({ status: "finished", output: { ok: true } }));
    let storageCtorArgs;
    let runCtorArgs;
    const provider = createGcpSandboxProvider({
      ...REQUIRED,
      importStorageSdk: async () => ({
        Storage: function Storage(opts) {
          storageCtorArgs = opts;
          return env.storage;
        },
      }),
      importRunSdk: async () => ({
        JobsClient: function JobsClient(opts) {
          runCtorArgs = opts;
          return env.run;
        },
      }),
      clientOptions: { storage: { extraStorage: 1 }, run: { extraRun: 2 } },
    });
    const result = await provider.run(makeRequest());
    expect(result.status).toBe("finished");
    expect(storageCtorArgs).toMatchObject({ projectId: "p", extraStorage: 1 });
    expect(runCtorArgs).toMatchObject({ projectId: "p", extraRun: 2 });
  });

  test("resolves the JobsClient from the v2 namespace export", async () => {
    const env = createMockGcpSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createGcpSandboxProvider({
      ...REQUIRED,
      clients: { storage: env.storage },
      importRunSdk: async () => ({
        v2: {
          JobsClient: function JobsClient() {
            return env.run;
          },
        },
      }),
    });
    const result = await provider.run(makeRequest());
    expect(result.status).toBe("finished");
  });

  test("storage SDK import failure surfaces an actionable install error", async () => {
    const env = createMockGcpSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createGcpSandboxProvider({
      ...REQUIRED,
      clients: { run: env.run },
      importStorageSdk: async () => {
        throw new Error("Cannot find package '@google-cloud/storage'");
      },
    });
    await expect(provider.run(makeRequest())).rejects.toThrow(/@google-cloud\/storage/);
  });

  test("storage SDK missing Storage export is rejected", async () => {
    const env = createMockGcpSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createGcpSandboxProvider({
      ...REQUIRED,
      clients: { run: env.run },
      importStorageSdk: async () => ({ NotStorage: 1 }),
    });
    await expect(provider.run(makeRequest())).rejects.toThrow(/does not export Storage/);
  });

  test("run SDK import failure surfaces an actionable install error", async () => {
    const env = createMockGcpSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createGcpSandboxProvider({
      ...REQUIRED,
      clients: { storage: env.storage },
      importRunSdk: async () => {
        throw new Error("Cannot find package '@google-cloud/run'");
      },
    });
    await expect(provider.run(makeRequest())).rejects.toThrow(/@google-cloud\/run/);
  });

  test("run SDK missing JobsClient export is rejected", async () => {
    const env = createMockGcpSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createGcpSandboxProvider({
      ...REQUIRED,
      clients: { storage: env.storage },
      importRunSdk: async () => ({ nope: true }),
    });
    await expect(provider.run(makeRequest())).rejects.toThrow(/does not export a v2 JobsClient/);
  });
});

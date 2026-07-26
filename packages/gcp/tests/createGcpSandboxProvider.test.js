import { describe, expect, test } from "bun:test";
import { GCP_SANDBOX_PROVIDER_ID } from "../src/GCP_SANDBOX_PROVIDER_ID.js";
import { createGcpSandboxProvider } from "../src/createGcpSandboxProvider.js";
import { createMockGcpSandboxEnvironment } from "../src/createMockGcpSandboxEnvironment.js";

let seq = 0;

/**
 * @param {Record<string, unknown>} [overrides]
 */
function makeRequest(overrides = {}) {
  const heartbeats = [];
  const n = seq++;
  const request = {
    runId: overrides.runId ?? `run-${n}`,
    sandboxId: overrides.sandboxId ?? `sbx-${n}`,
    input: overrides.input ?? { topic: "gcp" },
    config: overrides.config ?? { command: "echo hi" },
    rootDir: `/tmp/gcp-${n}/root`,
    requestBundlePath: `/tmp/gcp-${n}/request`,
    resultBundlePath: `/tmp/gcp-${n}/result`,
    workflow: /** @type {never} */ ({ build: () => null }),
    executeChildWorkflow: async () => ({ runId: "child", status: "finished", output: null }),
    allowNetwork: overrides.allowNetwork ?? false,
    maxOutputBytes: 1_000_000,
    toolTimeoutMs: 30_000,
    egress: overrides.egress,
    signal: overrides.signal,
    heartbeat: (d) => heartbeats.push(d ?? {}),
  };
  return { request, heartbeats };
}

const REQUIRED = { projectId: "p", location: "us-central1", bucket: "b", jobName: "j" };

describe("createGcpSandboxProvider", () => {
  test("default and custom provider id", () => {
    expect(
      createGcpSandboxProvider({ ...REQUIRED, client: createMockGcpSandboxEnvironment(() => ({ status: "finished" })) })
        .id,
    ).toBe(GCP_SANDBOX_PROVIDER_ID);
    expect(
      createGcpSandboxProvider({
        ...REQUIRED,
        id: "custom-gcp",
        client: createMockGcpSandboxEnvironment(() => ({ status: "finished" })),
      }).id,
    ).toBe("custom-gcp");
  });

  test("empty command is rejected", () => {
    expect(() => createGcpSandboxProvider({ ...REQUIRED, command: "   " })).toThrow(/must not be empty/);
  });

  test("invalid cleanup is rejected", () => {
    expect(() => createGcpSandboxProvider({ ...REQUIRED, cleanup: /** @type {never} */ ("nuke") })).toThrow(/cleanup/);
  });

  test("missing required options are rejected with clear INVALID_INPUT errors", async () => {
    const env = createMockGcpSandboxEnvironment(() => ({ status: "finished" }));
    for (const [drop, re] of [
      ["projectId", /projectId/],
      ["location", /location/],
      ["bucket", /bucket/],
      ["jobName", /jobName/],
    ]) {
      const opts = { ...REQUIRED, client: env };
      delete opts[drop];
      if (drop === "projectId") delete process.env.GOOGLE_CLOUD_PROJECT;
      const provider = createGcpSandboxProvider(opts);
      const { request } = makeRequest();
      await expect(provider.run(request)).rejects.toThrow(re);
    }
  });

  test("projectId falls back to GOOGLE_CLOUD_PROJECT", async () => {
    process.env.GOOGLE_CLOUD_PROJECT = "env-project";
    const env = createMockGcpSandboxEnvironment(() => ({ status: "finished", output: { ok: true } }));
    const provider = createGcpSandboxProvider({ location: "us-central1", bucket: "b", jobName: "j", client: env });
    const { request } = makeRequest();
    const result = await provider.run(request);
    expect(result.status).toBe("finished");
    delete process.env.GOOGLE_CLOUD_PROJECT;
  });

  test("injected client is used and default remote sandbox id is ${runId}-${sandboxId}", async () => {
    let seenEnv;
    const env = createMockGcpSandboxEnvironment(({ env: e }) => {
      seenEnv = e;
      return { status: "finished" };
    });
    const provider = createGcpSandboxProvider({ ...REQUIRED, client: env });
    const { request } = makeRequest({ runId: "R", sandboxId: "S" });
    await provider.run(request);
    expect(seenEnv.SMITHERS_SANDBOX_REQUEST_GCS_OBJECT).toContain("smithers/sandbox/R/R-S/");
  });

  test("custom sandboxId mapper is honored", async () => {
    let seenEnv;
    const env = createMockGcpSandboxEnvironment(({ env: e }) => {
      seenEnv = e;
      return { status: "finished" };
    });
    const provider = createGcpSandboxProvider({ ...REQUIRED, sandboxId: () => "fixed-id", client: env });
    await provider.run(makeRequest({ runId: "R", sandboxId: "S" }).request);
    expect(seenEnv.SMITHERS_SANDBOX_REQUEST_GCS_OBJECT).toContain("/R/fixed-id/");
  });

  test("request JSON reaches the container with input + config", async () => {
    let seenRequest;
    const env = createMockGcpSandboxEnvironment(({ request }) => {
      seenRequest = request;
      return { status: "finished" };
    });
    const provider = createGcpSandboxProvider({ ...REQUIRED, client: env });
    await provider.run(makeRequest({ input: { a: 1 }, config: { command: "run" } }).request);
    expect(seenRequest.input).toEqual({ a: 1 });
    expect(seenRequest.config).toEqual({ command: "run" });
  });

  test("command env includes the Smithers path vars + GCS transport vars", async () => {
    let seenEnv;
    const env = createMockGcpSandboxEnvironment(({ env: e }) => {
      seenEnv = e;
      return { status: "finished" };
    });
    const provider = createGcpSandboxProvider({ ...REQUIRED, client: env });
    await provider.run(makeRequest().request);
    expect(seenEnv.SMITHERS_SANDBOX_REQUEST_PATH).toBeString();
    expect(seenEnv.SMITHERS_SANDBOX_RESULT_PATH).toBeString();
    expect(seenEnv.SMITHERS_SANDBOX_GCS_BUCKET).toBe("b");
    expect(seenEnv.SMITHERS_SANDBOX_GCS_PREFIX).toBe("smithers/sandbox");
    expect(seenEnv.SMITHERS_SANDBOX_RESULT_GCS_OBJECT).toBeString();
  });

  test("runJob passes args=[sh,-c,command] and container env", async () => {
    const env = createMockGcpSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createGcpSandboxProvider({ ...REQUIRED, command: "node run.js", client: env });
    await provider.run(makeRequest().request);
    const container = env.runRequests[0].overrides.containerOverrides[0];
    expect(container.args).toEqual(["sh", "-c", "node run.js"]);
    expect(container.env.some((e) => e.name === "SMITHERS_SANDBOX_GCS_BUCKET")).toBe(true);
  });

  test("result parsed from the result GCS object", async () => {
    const env = createMockGcpSandboxEnvironment(() => ({ status: "finished", output: { done: true } }));
    const provider = createGcpSandboxProvider({ ...REQUIRED, client: env });
    const result = await provider.run(makeRequest().request);
    expect(result).toMatchObject({ status: "finished", output: { done: true } });
  });

  test("status:failed result surfaces as a normal failed bundle (not a throw)", async () => {
    const env = createMockGcpSandboxEnvironment(() => ({ status: "failed", output: { reason: "tests failed" } }));
    const provider = createGcpSandboxProvider({ ...REQUIRED, client: env });
    const result = await provider.run(makeRequest().request);
    expect(result.status).toBe("failed");
  });

  test("infra failure (execution failed, no result written) throws", async () => {
    const env = createMockGcpSandboxEnvironment(() => ({ status: "finished" }), {
      execution: { succeededCount: 0, failedCount: 1 },
    });
    const provider = createGcpSandboxProvider({ ...REQUIRED, client: env });
    await expect(provider.run(makeRequest().request)).rejects.toThrow(/exited with code 1/);
  });

  test("runJob failure is surfaced and redacted (no secret leaks)", async () => {
    const env = createMockGcpSandboxEnvironment(() => ({ status: "finished" }), { faults: { run: true } });
    const provider = createGcpSandboxProvider({ ...REQUIRED, env: { API_TOKEN: "super-secret-token" }, client: env });
    let err;
    try {
      await provider.run(makeRequest().request);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err.message)).not.toContain("super-secret-token");
  });

  test("GCS save failure during request shipping is surfaced", async () => {
    const env = createMockGcpSandboxEnvironment(() => ({ status: "finished" }), { faults: { save: true } });
    const provider = createGcpSandboxProvider({ ...REQUIRED, client: env });
    await expect(provider.run(makeRequest().request)).rejects.toThrow();
  });

  test("cleanup destroy tears down transient GCS objects", async () => {
    const env = createMockGcpSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createGcpSandboxProvider({ ...REQUIRED, cleanup: "destroy", client: env });
    const { request } = makeRequest();
    await provider.run(request);
    expect(env.objects.size).toBeGreaterThan(0);
    await provider.cleanup?.(request);
    expect(env.objects.size).toBe(0);
  });

  test("cleanup keep leaves transient GCS objects", async () => {
    const env = createMockGcpSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createGcpSandboxProvider({ ...REQUIRED, cleanup: "keep", client: env });
    const { request } = makeRequest();
    await provider.run(request);
    const size = env.objects.size;
    await provider.cleanup?.(request);
    expect(env.objects.size).toBe(size);
  });

  test("per-run createJob creates then deletes the job on destroy", async () => {
    const env = createMockGcpSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createGcpSandboxProvider({
      ...REQUIRED,
      createJob: true,
      image: "gcr.io/smithers/sandbox-runner",
      client: env,
    });
    const { request } = makeRequest();
    await provider.run(request);
    expect(env.createdJobs.length).toBe(1);
    await provider.cleanup?.(request);
    expect(env.deletedJobs.length).toBe(1);
  });

  test("reused job is never created or deleted", async () => {
    const env = createMockGcpSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createGcpSandboxProvider({ ...REQUIRED, client: env });
    const { request } = makeRequest();
    await provider.run(request);
    await provider.cleanup?.(request);
    expect(env.createdJobs.length).toBe(0);
    expect(env.deletedJobs.length).toBe(0);
  });

  test("cancellation via aborted signal throws", async () => {
    const env = createMockGcpSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createGcpSandboxProvider({ ...REQUIRED, client: env });
    const controller = new AbortController();
    controller.abort();
    await expect(provider.run(makeRequest({ signal: controller.signal }).request)).rejects.toThrow(/cancel/i);
  });

  test("egress secrets are sanitized in the shipped request JSON", async () => {
    let seenRequest;
    const env = createMockGcpSandboxEnvironment(({ request }) => {
      seenRequest = request;
      return { status: "finished" };
    });
    const provider = createGcpSandboxProvider({ ...REQUIRED, client: env });
    await provider.run(
      makeRequest({
        egress: { httpsProxy: "https://proxy:8443", secretBindings: { PROXY_TOKEN: "leaky-secret-value" } },
      }).request,
    );
    expect(JSON.stringify(seenRequest.egress)).not.toContain("leaky-secret-value");
  });

  test("CA GCS object env is injected only when egress carries an inline caCertPem", async () => {
    let seenEnv;
    const env = createMockGcpSandboxEnvironment(({ env: e }) => {
      seenEnv = e;
      return { status: "finished" };
    });
    const provider = createGcpSandboxProvider({ ...REQUIRED, client: env });

    // No egress CA -> no CA object env injected.
    await provider.run(makeRequest().request);
    expect(seenEnv.SMITHERS_SANDBOX_CA_GCS_OBJECT).toBeUndefined();

    // Inline egress CA -> the GCS object the CA was uploaded to is injected,
    // and that object actually holds the uploaded PEM.
    const caCertPem = "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n";
    await provider.run(makeRequest({ egress: { caCertPem } }).request);
    expect(seenEnv.SMITHERS_SANDBOX_CA_GCS_OBJECT).toBeString();
    expect(seenEnv.SMITHERS_SANDBOX_CA_GCS_OBJECT).toContain("/.smithers/egress/ca.crt");
    expect(env.objects.get(seenEnv.SMITHERS_SANDBOX_CA_GCS_OBJECT)).toContain("BEGIN CERTIFICATE");
  });

  test("remoteId reflects the Cloud Run execution name after exec", async () => {
    const env = createMockGcpSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createGcpSandboxProvider({ ...REQUIRED, client: env });
    const { request } = makeRequest();
    const result = await provider.run(request);
    expect(String(result.remoteRunId)).toContain("/executions/exec-");
  });

  test("heartbeat stages are present", async () => {
    const env = createMockGcpSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createGcpSandboxProvider({ ...REQUIRED, client: env });
    const { request, heartbeats } = makeRequest();
    await provider.run(request);
    const stages = heartbeats.map((h) => h.stage);
    expect(stages).toContain(`${GCP_SANDBOX_PROVIDER_ID}-session-created`);
    expect(stages).toContain(`${GCP_SANDBOX_PROVIDER_ID}-request-shipped`);
    expect(stages).toContain(`${GCP_SANDBOX_PROVIDER_ID}-result-read`);
  });
});

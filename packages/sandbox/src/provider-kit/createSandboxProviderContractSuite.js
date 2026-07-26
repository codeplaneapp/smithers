import { describe, expect, test } from "bun:test";

/**
 * Define a reusable bun:test contract suite that every command-backed sandbox
 * provider package can run against its own createProvider factory. It exercises
 * the happy path and the SandboxProvider shape invariants. Exhaustive
 * error/redaction/timeout paths live in the kit's own unit test, not here.
 *
 * @param {{
 *   name: string;
 *   expectedProviderId: string;
 *   createProvider: (
 *     handler: (args: { command: string; request: Record<string, unknown>; files: Map<string, string>; env: Record<string, string> }) => import("../SandboxProvider.ts").SandboxProviderResult | Promise<import("../SandboxProvider.ts").SandboxProviderResult>,
 *     providerOptions?: Record<string, unknown>,
 *   ) => import("../SandboxProvider.ts").SandboxProvider;
 *   createRequest?: (overrides?: Record<string, unknown>) => { request: import("../SandboxProvider.ts").SandboxProviderRequest; heartbeats: unknown[] };
 * }} config
 * @returns {void}
 */
export function createSandboxProviderContractSuite(config) {
  const { name, expectedProviderId, createProvider } = config;
  const buildRequest = config.createRequest ?? defaultCreateRequest;

  describe(name, () => {
    test("provider id matches the expected id", () => {
      const provider = createProvider(() => ({ status: "finished", output: null }));
      expect(provider.id).toBe(expectedProviderId);
    });

    test("finished result passes through with string remote ids", async () => {
      const provider = createProvider(() => ({ status: "finished", output: { done: true } }));
      const { request } = buildRequest();
      const result = await provider.run(request);
      expect(result.status).toBe("finished");
      expect(typeof result.remoteRunId).toBe("string");
      expect(typeof result.workspaceId).toBe("string");
      expect(typeof result.containerId).toBe("string");
    });

    test("failed result passes through", async () => {
      const provider = createProvider(() => ({ status: "failed", output: { reason: "boom" } }));
      const { request } = buildRequest();
      const result = await provider.run(request);
      expect(result.status).toBe("failed");
    });

    test("cancelled result passes through", async () => {
      const provider = createProvider(() => ({ status: "cancelled" }));
      const { request } = buildRequest();
      const result = await provider.run(request);
      expect(result.status).toBe("cancelled");
    });

    test("bundlePath result passes through with remote ids filled", async () => {
      const provider = createProvider(() => ({ bundlePath: "/remote/bundle" }));
      const { request } = buildRequest();
      const result = await provider.run(request);
      expect(result.bundlePath).toBe("/remote/bundle");
      expect(typeof result.remoteRunId).toBe("string");
      expect(typeof result.workspaceId).toBe("string");
      expect(typeof result.containerId).toBe("string");
    });

    test("request JSON carries runId, sandboxId, input, and config", async () => {
      /** @type {Record<string, unknown> | undefined} */
      let seen;
      const provider = createProvider(({ request }) => {
        seen = request;
        return { status: "finished" };
      });
      const { request } = buildRequest();
      await provider.run(request);
      expect(seen?.runId).toBe(request.runId);
      expect(seen?.sandboxId).toBe(request.sandboxId);
      expect(seen?.input).toEqual(request.input);
      expect(seen?.config).toEqual(request.config);
    });

    test("request JSON carries allowNetwork/maxOutputBytes and sanitizes egress secrets", async () => {
      /** @type {Record<string, unknown> | undefined} */
      let seen;
      const provider = createProvider(({ request }) => {
        seen = request;
        return { status: "finished" };
      });
      const { request } = buildRequest({
        egress: {
          httpsProxy: "https://proxy.example:8443",
          secretBindings: { PROXY_TOKEN: "super-secret-token-value" },
        },
      });
      await provider.run(request);
      expect(seen?.allowNetwork).toBe(request.allowNetwork);
      expect(seen?.maxOutputBytes).toBe(request.maxOutputBytes);
      expect(JSON.stringify(seen?.egress)).not.toContain("super-secret-token-value");
    });

    test("exec env carries both sandbox path variables", async () => {
      /** @type {Record<string, string> | undefined} */
      let seen;
      const provider = createProvider(({ env }) => {
        seen = env;
        return { status: "finished" };
      });
      const { request } = buildRequest();
      await provider.run(request);
      expect(typeof seen?.SMITHERS_SANDBOX_REQUEST_PATH).toBe("string");
      expect(typeof seen?.SMITHERS_SANDBOX_RESULT_PATH).toBe("string");
    });

    test("options.env value is merged into exec env", async () => {
      /** @type {Record<string, string> | undefined} */
      let seen;
      const provider = createProvider(
        ({ env }) => {
          seen = env;
          return { status: "finished" };
        },
        { env: { CONTRACT_FLAG: "on" } },
      );
      const { request } = buildRequest();
      await provider.run(request);
      expect(seen?.CONTRACT_FLAG).toBe("on");
    });

    test("a session-created heartbeat carries remoteId", async () => {
      const provider = createProvider(() => ({ status: "finished" }));
      const { request, heartbeats } = buildRequest();
      await provider.run(request);
      const created = heartbeats.find(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          String(/** @type {{ stage?: unknown }} */ (entry).stage ?? "").endsWith("-session-created"),
      );
      expect(created).toBeDefined();
      expect(typeof (/** @type {{ remoteId?: unknown }} */ (created)?.remoteId)).toBe("string");
    });

    test("non-empty config reaches the request JSON", async () => {
      /** @type {Record<string, unknown> | undefined} */
      let seen;
      const provider = createProvider(({ request }) => {
        seen = request;
        return { status: "finished" };
      });
      const { request } = buildRequest({ config: { region: "contract-region", replicas: 3 } });
      await provider.run(request);
      expect(seen?.config).toEqual({ region: "contract-region", replicas: 3 });
    });

    test("session-created, request-shipped, and result-read heartbeats all fire", async () => {
      const provider = createProvider(() => ({ status: "finished" }));
      const { request, heartbeats } = buildRequest();
      await provider.run(request);
      const stages = heartbeats
        .map((entry) =>
          typeof entry === "object" && entry !== null
            ? String(/** @type {{ stage?: unknown }} */ (entry).stage ?? "")
            : "",
        )
        .filter((stage) => stage.length > 0);
      expect(stages.some((stage) => stage.endsWith("-session-created"))).toBe(true);
      expect(stages.some((stage) => stage.endsWith("-request-shipped"))).toBe(true);
      expect(stages.some((stage) => stage.endsWith("-result-read"))).toBe(true);
    });

    test("result satisfies materializeProviderResult shape", async () => {
      const provider = createProvider(() => ({ status: "finished", output: null }));
      const { request } = buildRequest();
      const result = /** @type {Record<string, unknown>} */ (await provider.run(request));
      const hasBundlePath = typeof result.bundlePath === "string" && result.bundlePath.length > 0;
      const hasStatus = result.status === "finished" || result.status === "failed" || result.status === "cancelled";
      expect(hasBundlePath || hasStatus).toBe(true);
    });

    test('cleanup "destroy" calls destroy', async () => {
      let destroyed = false;
      const provider = createProvider(() => ({ status: "finished" }), {
        cleanup: "destroy",
        onDestroy: () => {
          destroyed = true;
        },
      });
      const { request } = buildRequest();
      await provider.run(request);
      await provider.cleanup?.(request);
      expect(destroyed).toBe(true);
    });

    test('cleanup "keep" does not call destroy', async () => {
      let destroyed = false;
      const markDestroyed = () => {
        destroyed = true;
      };
      const provider = createProvider(() => ({ status: "finished" }), { cleanup: "keep", onDestroy: markDestroyed });
      const { request } = buildRequest();
      await provider.run(request);
      await provider.cleanup?.(request);
      expect(destroyed).toBe(false);
      // Prove the spy itself works, so the false above means cleanup
      // really skipped destroy rather than the spy being inert.
      markDestroyed();
      expect(destroyed).toBe(true);
    });

    test("cleanup is idempotent when called twice", async () => {
      const provider = createProvider(() => ({ status: "finished" }), { cleanup: "destroy" });
      const { request } = buildRequest();
      await provider.run(request);
      await provider.cleanup?.(request);
      await provider.cleanup?.(request);
    });
  });
}

let requestCounter = 0;

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {{ request: import("../SandboxProvider.ts").SandboxProviderRequest; heartbeats: unknown[] }}
 */
function defaultCreateRequest(overrides = {}) {
  /** @type {unknown[]} */
  const heartbeats = [];
  const seq = requestCounter++;
  /** @type {import("../SandboxProvider.ts").SandboxProviderRequest} */
  const request = {
    runId: "run-contract",
    sandboxId: "sbx-contract",
    input: overrides.input ?? { hello: "world" },
    config: /** @type {Record<string, unknown>} */ (overrides.config) ?? {},
    rootDir: `/tmp/smithers-contract-${seq}/root`,
    requestBundlePath: `/tmp/smithers-contract-${seq}/request`,
    resultBundlePath: `/tmp/smithers-contract-${seq}/result`,
    workflow: /** @type {never} */ (() => ({ build: () => null })),
    executeChildWorkflow: /** @type {never} */ (async () => ({ runId: "child", status: "finished", output: null })),
    allowNetwork: false,
    maxOutputBytes: 1_000_000,
    toolTimeoutMs: 60_000,
    egress: /** @type {import("../SandboxEgressConfig.ts").SandboxEgressConfig | undefined} */ (overrides.egress),
    signal: /** @type {AbortSignal | undefined} */ (overrides.signal),
    heartbeat: (d) => heartbeats.push(d ?? {}),
  };
  return { request, heartbeats };
}

import { describe, expect, test } from "bun:test";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { VERCEL_SANDBOX_PROVIDER_ID } from "../src/VERCEL_SANDBOX_PROVIDER_ID.js";
import { createVercelSandboxProvider } from "../src/createVercelSandboxProvider.js";
import { createMockVercelSandboxEnvironment } from "../src/createMockVercelSandboxEnvironment.js";

/**
 * @param {Record<string, unknown>} [overrides]
 */
function makeRequest(overrides = {}) {
  /** @type {unknown[]} */
  const heartbeats = [];
  const request = {
    runId: "run-1",
    sandboxId: "sbx-1",
    input: { topic: "vercel" },
    config: { model: "opus" },
    rootDir: "/tmp/root",
    requestBundlePath: "/tmp/request",
    resultBundlePath: "/tmp/result",
    workflow: () => ({ build: () => null }),
    executeChildWorkflow: async () => ({ runId: "child", status: "finished", output: null }),
    allowNetwork: false,
    maxOutputBytes: 1_000_000,
    toolTimeoutMs: 60_000,
    heartbeat: (d) => heartbeats.push(d ?? {}),
    ...overrides,
  };
  return { request, heartbeats };
}

/**
 * Model the real SDK's additive `extendTimeout` semantics: a sandbox lives for
 * its create `timeout` plus every extension, so this is the lifetime Vercel
 * actually bills and plan-caps.
 *
 * @param {{ createCalls: unknown[]; sandboxes: unknown[] }} env
 * @param {number} index
 * @returns {number}
 */
function totalLifetimeMs(env, index) {
  const created = /** @type {{ timeout?: number }} */ (env.createCalls[index])?.timeout ?? 0;
  const extensions = /** @type {{ extendTimeoutCalls: number[] }} */ (env.sandboxes[index]).extendTimeoutCalls;
  return extensions.reduce((total, ms) => total + ms, created);
}

/**
 * Ensure ambient Vercel credentials never leak into option-driven tests.
 */
function withoutVercelEnv(run) {
  const keys = ["VERCEL_OIDC_TOKEN", "VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"];
  const saved = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return run();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

describe("createVercelSandboxProvider", () => {
  test("defaults to the vercel-sandbox provider id", () => {
    const provider = createVercelSandboxProvider({
      client: createMockVercelSandboxEnvironment(() => ({ status: "finished" })),
      oidcToken: "t",
    });
    expect(provider.id).toBe(VERCEL_SANDBOX_PROVIDER_ID);
  });

  test("accepts a custom provider id", () => {
    const provider = createVercelSandboxProvider({
      id: "custom-vercel",
      client: createMockVercelSandboxEnvironment(() => ({ status: "finished" })),
      oidcToken: "t",
    });
    expect(provider.id).toBe("custom-vercel");
  });

  test("rejects an empty command up front", () => {
    expect(() => createVercelSandboxProvider({ command: "   ", oidcToken: "t" })).toThrow(SmithersError);
  });

  test("rejects an invalid cleanup mode up front", () => {
    expect(() => createVercelSandboxProvider({ cleanup: "burn", oidcToken: "t" })).toThrow(SmithersError);
  });

  test("rejects a non-positive maxDurationMs", () => {
    expect(() => createVercelSandboxProvider({ maxDurationMs: 0, oidcToken: "t" })).toThrow(SmithersError);
  });

  test("rejects a non-positive or non-finite timeoutMs up front", () => {
    expect(() => createVercelSandboxProvider({ timeoutMs: 0, oidcToken: "t" })).toThrow(SmithersError);
    expect(() => createVercelSandboxProvider({ timeoutMs: -5, oidcToken: "t" })).toThrow(SmithersError);
    expect(() => createVercelSandboxProvider({ timeoutMs: Number.NaN, oidcToken: "t" })).toThrow(SmithersError);
  });

  test("defers to SDK env self-discovery (no throw) when no auth is configured", async () => {
    await withoutVercelEnv(async () => {
      const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
      const provider = createVercelSandboxProvider({ client: env });
      const result = await provider.run(makeRequest().request);
      // The real SDK self-discovers credentials from the environment, so we
      // pass no credential fields rather than throwing.
      expect(result).toMatchObject({ status: "finished" });
      expect(env.createCalls[0].token).toBeUndefined();
      expect(env.createCalls[0].teamId).toBeUndefined();
      expect(env.createCalls[0].projectId).toBeUndefined();
      expect("oidcToken" in env.createCalls[0]).toBe(false);
    });
  });

  test("maps an explicit OIDC token into the SDK token field (no oidcToken param)", async () => {
    await withoutVercelEnv(async () => {
      const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
      const provider = createVercelSandboxProvider({
        client: env,
        oidcToken: "oidc-abc",
        token: "tok-def",
        teamId: "team-1",
        projectId: "proj-1",
      });
      await provider.run(makeRequest().request);
      // OIDC is preferred and rides the `token` field; there is no fictional
      // `oidcToken` create param, and the access-token trio is not sent.
      expect(env.createCalls[0].token).toBe("oidc-abc");
      expect(env.createCalls[0].teamId).toBeUndefined();
      expect(env.createCalls[0].projectId).toBeUndefined();
      expect("oidcToken" in env.createCalls[0]).toBe(false);
    });
  });

  test("falls back to the access-token trio when no OIDC token is present", async () => {
    await withoutVercelEnv(async () => {
      const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
      const provider = createVercelSandboxProvider({
        client: env,
        token: "tok-def",
        teamId: "team-1",
        projectId: "proj-1",
      });
      await provider.run(makeRequest().request);
      expect(env.createCalls[0]).toMatchObject({ token: "tok-def", teamId: "team-1", projectId: "proj-1" });
      expect("oidcToken" in env.createCalls[0]).toBe(false);
    });
  });

  test("reads the OIDC token from the environment into the SDK token field", async () => {
    await withoutVercelEnv(async () => {
      process.env.VERCEL_OIDC_TOKEN = "env-oidc";
      const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
      const provider = createVercelSandboxProvider({ client: env });
      await provider.run(makeRequest().request);
      expect(env.createCalls[0].token).toBe("env-oidc");
      expect("oidcToken" in env.createCalls[0]).toBe(false);
    });
  });

  test("create receives runtime, resources, and the create timeout", async () => {
    const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createVercelSandboxProvider({ client: env, oidcToken: "t", runtime: "node22", vcpus: 4 });
    await provider.run(makeRequest({ toolTimeoutMs: 120_000 }).request);
    expect(env.createCalls[0]).toMatchObject({ runtime: "node22", resources: { vcpus: 4 }, timeout: 120_000 });
  });

  test("create omits resources entirely when no vcpus is set", async () => {
    const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createVercelSandboxProvider({ client: env, oidcToken: "t" });
    await provider.run(makeRequest().request);
    expect("resources" in env.createCalls[0]).toBe(false);
  });

  test("create is provisioned with the declared ports", async () => {
    const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createVercelSandboxProvider({ client: env, oidcToken: "t", ports: [3000, 8080] });
    await provider.run(makeRequest().request);
    expect(env.createCalls[0].ports).toEqual([3000, 8080]);
  });

  test("create omits ports when none are declared", async () => {
    const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createVercelSandboxProvider({ client: env, oidcToken: "t" });
    await provider.run(makeRequest().request);
    expect("ports" in env.createCalls[0]).toBe(false);
  });

  describe("exec abort / timeout", () => {
    test("exec with an already-aborted signal rejects without running the command", async () => {
      const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
      const provider = createVercelSandboxProvider({ client: env, oidcToken: "t" });
      let error;
      try {
        await provider.run(makeRequest({ signal: AbortSignal.abort() }).request);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(SmithersError);
      expect(error.code).toBe("SANDBOX_EXECUTION_FAILED");
      expect(error.message).toContain("aborted");
      // The command never runs once the signal is already aborted.
      expect(env.sandboxes[0]?.runCommandCalls ?? 0).toBe(0);
    });

    test("aborting mid-exec rejects promptly rather than waiting for the command", async () => {
      const controller = new AbortController();
      // A handler that never settles: only the abort race can end the exec.
      const env = createMockVercelSandboxEnvironment(() => new Promise(() => {}));
      const provider = createVercelSandboxProvider({ client: env, oidcToken: "t" });
      const started = Date.now();
      const runPromise = provider.run(makeRequest({ signal: controller.signal, toolTimeoutMs: 60_000 }).request);
      setTimeout(() => controller.abort(), 10);
      let error;
      try {
        await runPromise;
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(SmithersError);
      expect(error.code).toBe("SANDBOX_EXECUTION_FAILED");
      expect(error.message).toContain("aborted");
      // Rejects on abort, not after the 60s command timeout.
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    test("forwards the tool timeout to the SDK runCommand input", async () => {
      const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
      const provider = createVercelSandboxProvider({ client: env, oidcToken: "t" });
      await provider.run(makeRequest({ toolTimeoutMs: 42_000 }).request);
      expect(env.sandboxes[0]?.lastRunInput?.timeoutMs).toBe(42_000);
    });

    test("forwards the command abort signal to the SDK runCommand input", async () => {
      const controller = new AbortController();
      const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
      const provider = createVercelSandboxProvider({ client: env, oidcToken: "t" });
      await provider.run(makeRequest({ signal: controller.signal, toolTimeoutMs: undefined }).request);
      expect(env.sandboxes[0]?.lastRunInput?.signal).toBe(controller.signal);
    });

    test("local timeout rejects when the command never settles", async () => {
      // A handler that never settles: only the local timeout race can end it.
      const env = createMockVercelSandboxEnvironment(() => new Promise(() => {}));
      const provider = createVercelSandboxProvider({ client: env, oidcToken: "t" });
      const started = Date.now();
      let error;
      try {
        await provider.run(makeRequest({ toolTimeoutMs: 40 }).request);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(SmithersError);
      expect(error.code).toBe("SANDBOX_EXECUTION_FAILED");
      expect(error.message).toContain("timed out");
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  });

  test("ships the request JSON (input + config) into the sandbox and injects path env vars", async () => {
    let seenRequest;
    let seenEnv;
    let seenCommand;
    const env = createMockVercelSandboxEnvironment(({ request, env: commandEnv, command }) => {
      seenRequest = request;
      seenEnv = commandEnv;
      seenCommand = command;
      return { status: "finished", output: { ok: true } };
    });
    const provider = createVercelSandboxProvider({ client: env, oidcToken: "t", command: "node run.js" });
    const result = await provider.run(makeRequest().request);
    expect(seenCommand).toBe("node run.js");
    expect(seenRequest).toMatchObject({
      runId: "run-1",
      sandboxId: "sbx-1",
      input: { topic: "vercel" },
      config: { model: "opus" },
    });
    expect(typeof seenEnv.SMITHERS_SANDBOX_REQUEST_PATH).toBe("string");
    expect(typeof seenEnv.SMITHERS_SANDBOX_RESULT_PATH).toBe("string");
    expect(result).toMatchObject({ status: "finished", output: { ok: true } });
  });

  test("uses the default /vercel/sandbox workdir for the path env vars", async () => {
    let seenEnv;
    const env = createMockVercelSandboxEnvironment(({ env: commandEnv }) => {
      seenEnv = commandEnv;
      return { status: "finished" };
    });
    const provider = createVercelSandboxProvider({ client: env, oidcToken: "t" });
    await provider.run(makeRequest().request);
    expect(seenEnv.SMITHERS_SANDBOX_REQUEST_PATH).toBe("/vercel/sandbox/.smithers/sandbox-request.json");
    expect(seenEnv.SMITHERS_SANDBOX_RESULT_PATH).toBe("/vercel/sandbox/.smithers/sandbox-result.json");
  });

  test("fills remote ids from the sandbox id", async () => {
    const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createVercelSandboxProvider({ client: env, oidcToken: "t" });
    const result = await provider.run(makeRequest().request);
    expect(result.remoteRunId).toBe("vercel-sandbox-1");
    expect(result.workspaceId).toBe("vercel-sandbox-1");
    expect(result.containerId).toBe("vercel-sandbox-1");
  });

  test("fills remote ids from the 2.x sandbox .name when sandboxId is absent", async () => {
    // The 2.x SDK exposes the id as `.name`, not `.sandboxId`. Emulate that
    // shape by proxying the mock sandbox.
    const base = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
    const client = {
      create: async (opts) => {
        const sandbox = await base.create(opts);
        return new Proxy(sandbox, {
          get(target, prop) {
            if (prop === "sandboxId") return undefined;
            if (prop === "name") return target.sandboxId;
            return Reflect.get(target, prop);
          },
        });
      },
    };
    const provider = createVercelSandboxProvider({ client, oidcToken: "t" });
    const result = await provider.run(makeRequest().request);
    expect(result.remoteRunId).toBe("vercel-sandbox-1");
    expect(result.workspaceId).toBe("vercel-sandbox-1");
    expect(result.containerId).toBe("vercel-sandbox-1");
  });

  test("decodes a Node ReadableStream result file so JSON round-trips", async () => {
    // Real @vercel/sandbox readFile resolves a Node ReadableStream. This must
    // FAIL against the old String()-based decoder (which yields "[object …]"
    // and breaks the result-file JSON parse).
    const env = createMockVercelSandboxEnvironment(() => ({ status: "finished", output: { ok: true, n: 42 } }), {
      streamReads: true,
    });
    const provider = createVercelSandboxProvider({ client: env, oidcToken: "t" });
    const result = await provider.run(makeRequest().request);
    expect(result).toMatchObject({ status: "finished", output: { ok: true, n: 42 } });
  });

  test("fills remote ids from the 2.x sandbox .name when sandboxId is absent", async () => {
    // The 2.x SDK exposes the id as `.name`, not `.sandboxId`. Emulate that
    // shape by proxying the mock sandbox.
    const base = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
    const client = {
      create: async (opts) => {
        const sandbox = await base.create(opts);
        return new Proxy(sandbox, {
          get(target, prop) {
            if (prop === "sandboxId") return undefined;
            if (prop === "name") return target.sandboxId;
            return Reflect.get(target, prop);
          },
        });
      },
    };
    const provider = createVercelSandboxProvider({ client, oidcToken: "t" });
    const result = await provider.run(makeRequest().request);
    expect(result.remoteRunId).toBe("vercel-sandbox-1");
    expect(result.workspaceId).toBe("vercel-sandbox-1");
    expect(result.containerId).toBe("vercel-sandbox-1");
  });

  test("decodes a Node ReadableStream result file so JSON round-trips", async () => {
    // Real @vercel/sandbox readFile resolves a Node ReadableStream. This must
    // FAIL against the old String()-based decoder (which yields "[object …]"
    // and breaks the result-file JSON parse).
    const env = createMockVercelSandboxEnvironment(() => ({ status: "finished", output: { ok: true, n: 42 } }), {
      streamReads: true,
    });
    const provider = createVercelSandboxProvider({ client: env, oidcToken: "t" });
    const result = await provider.run(makeRequest().request);
    expect(result).toMatchObject({ status: "finished", output: { ok: true, n: 42 } });
  });

  describe("duration / plan cap", () => {
    test("a duration within the create ceiling does not extend", async () => {
      const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
      const provider = createVercelSandboxProvider({ client: env, oidcToken: "t" });
      const { request, heartbeats } = makeRequest({ toolTimeoutMs: 60_000 });
      await provider.run(request);
      expect(env.sandboxes[0].extendTimeoutCalls).toEqual([]);
      expect(heartbeats.some((h) => String(h?.stage ?? "").endsWith("-timeout-extend"))).toBe(false);
    });

    test("a duration above the ceiling but within the cap warns and extends", async () => {
      const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
      const provider = createVercelSandboxProvider({ client: env, oidcToken: "t", timeoutMs: 10 * 60_000 });
      const { request, heartbeats } = makeRequest();
      await provider.run(request);
      expect(env.createCalls[0].timeout).toBe(5 * 60_000);
      // extendTimeout extends BY its argument, so only the remaining delta is
      // sent; the resulting lifetime is exactly the requested duration.
      expect(env.sandboxes[0].extendTimeoutCalls).toEqual([5 * 60_000]);
      expect(totalLifetimeMs(env, 0)).toBe(10 * 60_000);
      const warn = heartbeats.find((h) => String(h?.stage ?? "").endsWith("-timeout-extend"));
      expect(warn).toBeDefined();
      expect(warn.level).toBe("warn");
      expect(warn.requestedMs).toBe(10 * 60_000);
    });

    test("a duration exactly at the plan cap does not overshoot it", async () => {
      const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
      const provider = createVercelSandboxProvider({ client: env, oidcToken: "t", timeoutMs: 45 * 60_000 });
      await provider.run(makeRequest().request);
      expect(env.sandboxes[0].extendTimeoutCalls).toEqual([40 * 60_000]);
      expect(totalLifetimeMs(env, 0)).toBe(45 * 60_000);
    });

    test("a duration above the plan cap throws INVALID_INPUT", async () => {
      const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
      const provider = createVercelSandboxProvider({ client: env, oidcToken: "t", timeoutMs: 60 * 60_000 });
      let error;
      try {
        await provider.run(makeRequest().request);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(SmithersError);
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toContain("plan cap");
      expect(env.sandboxes).toHaveLength(0);
    });

    test("a raised maxDurationMs permits a longer duration", async () => {
      const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
      const provider = createVercelSandboxProvider({
        client: env,
        oidcToken: "t",
        timeoutMs: 60 * 60_000,
        maxDurationMs: 90 * 60_000,
      });
      await provider.run(makeRequest().request);
      expect(env.sandboxes[0].extendTimeoutCalls).toEqual([55 * 60_000]);
      expect(totalLifetimeMs(env, 0)).toBe(60 * 60_000);
    });

    test("post-create setup failure destroys the created sandbox", async () => {
      const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }), { fail: "extendTimeout" });
      const provider = createVercelSandboxProvider({ client: env, oidcToken: "t", timeoutMs: 10 * 60_000 });
      let error;
      try {
        await provider.run(makeRequest().request);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(SmithersError);
      expect(error.code).toBe("SANDBOX_EXECUTION_FAILED");
      expect(error.message).toContain("setup failed");
      expect(env.sandboxes).toHaveLength(1);
      expect(env.sandboxes[0].deleted).toBe(true);
    });
  });

  test("declared ports surface sandbox domains in a heartbeat", async () => {
    const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createVercelSandboxProvider({ client: env, oidcToken: "t", ports: [3000, 8080] });
    const { request, heartbeats } = makeRequest();
    await provider.run(request);
    const portsBeat = heartbeats.find((h) => String(h?.stage ?? "").endsWith("-ports"));
    expect(portsBeat).toBeDefined();
    expect(portsBeat.domains["3000"]).toBe("https://vercel-sandbox-1-3000.vercel.run");
    expect(portsBeat.domains["8080"]).toBe("https://vercel-sandbox-1-8080.vercel.run");
  });

  describe("cleanup", () => {
    test("default destroy deletes the sandbox", async () => {
      const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
      const provider = createVercelSandboxProvider({ client: env, oidcToken: "t" });
      const { request } = makeRequest();
      await provider.run(request);
      await provider.cleanup?.(request);
      expect(env.sandboxes[0].deleted).toBe(true);
      expect(env.sandboxes[0].stopped).toBe(false);
    });

    test("persist stops the sandbox instead of deleting it", async () => {
      const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
      const provider = createVercelSandboxProvider({ client: env, oidcToken: "t", persist: true });
      const { request } = makeRequest();
      await provider.run(request);
      await provider.cleanup?.(request);
      expect(env.sandboxes[0].stopped).toBe(true);
      expect(env.sandboxes[0].deleted).toBe(false);
    });

    test("cleanup keep leaves the sandbox untouched", async () => {
      const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
      const provider = createVercelSandboxProvider({ client: env, oidcToken: "t", cleanup: "keep" });
      const { request } = makeRequest();
      await provider.run(request);
      await provider.cleanup?.(request);
      expect(env.sandboxes[0].destroyed).toBe(false);
    });
  });

  test("a create failure surfaces as SANDBOX_EXECUTION_FAILED with the auth token redacted", async () => {
    const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }), { fail: "create" });
    const provider = createVercelSandboxProvider({ client: env, oidcToken: "super-secret-oidc-token" });
    let error;
    try {
      await provider.run(makeRequest().request);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SmithersError);
    expect(error.code).toBe("SANDBOX_EXECUTION_FAILED");
    expect(error.message).not.toContain("super-secret-oidc-token");
  });

  test("exec with neither a signal nor a timeout returns the command promise directly", async () => {
    // request.toolTimeoutMs undefined + no signal => raceCommand short-circuits.
    const env = createMockVercelSandboxEnvironment(() => ({ status: "finished", output: { ok: true } }));
    const provider = createVercelSandboxProvider({ client: env, oidcToken: "t" });
    const result = await provider.run(makeRequest({ toolTimeoutMs: undefined }).request);
    expect(result).toMatchObject({ status: "finished", output: { ok: true } });
    // No per-command timeout was forwarded to the SDK.
    expect("timeoutMs" in (env.sandboxes[0]?.lastRunInput ?? {})).toBe(false);
  });

  describe("teardown variants", () => {
    test("a setup failure whose cleanup delete also fails emits a cleanup-failed heartbeat", async () => {
      const secret = "cleanup-secret-xyz";
      const base = createMockVercelSandboxEnvironment(() => ({ status: "finished" }), { fail: "extendTimeout" });
      const client = {
        create: async (opts) => {
          const sandbox = await base.create(opts);
          return new Proxy(sandbox, {
            get(target, prop) {
              if (prop === "delete") {
                return async () => {
                  throw new Error(`delete failed using ${secret}`);
                };
              }
              return Reflect.get(target, prop);
            },
          });
        },
      };
      const provider = createVercelSandboxProvider({
        client,
        oidcToken: "t",
        timeoutMs: 10 * 60_000,
        env: { CLEANUP_SECRET: secret },
      });
      const { request, heartbeats } = makeRequest();
      let error;
      try {
        await provider.run(request);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(SmithersError);
      expect(error.code).toBe("SANDBOX_EXECUTION_FAILED");
      expect(error.message).toContain("setup failed");
      const cleanupBeat = heartbeats.find((h) => String(h?.stage ?? "").endsWith("-cleanup-failed"));
      expect(cleanupBeat).toBeDefined();
      expect(cleanupBeat.level).toBe("warn");
      // The env secret is scrubbed out of the cleanup-failed heartbeat error.
      expect(JSON.stringify(cleanupBeat)).not.toContain(secret);
    });

    test("destroy stops the sandbox when the SDK exposes no delete (non-persist)", async () => {
      const base = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
      const client = {
        create: async (opts) => {
          const sandbox = await base.create(opts);
          return new Proxy(sandbox, {
            get(target, prop) {
              // Emulate an SDK surface that only supports stop(), no delete().
              if (prop === "delete") return undefined;
              return Reflect.get(target, prop);
            },
          });
        },
      };
      const provider = createVercelSandboxProvider({ client, oidcToken: "t" });
      const { request } = makeRequest();
      await provider.run(request);
      await provider.cleanup?.(request);
      expect(base.sandboxes[0].stopped).toBe(true);
      expect(base.sandboxes[0].deleted).toBe(false);
    });
  });

  describe("readFile decode shapes", () => {
    /**
     * Wrap a mock env so the result-file `readFile` resolves an arbitrary SDK
     * value shape carrying the JSON string, exercising decodeVercelFile.
     * @param {(str: string) => unknown} wrap
     */
    function envWithReadShape(wrap) {
      const base = createMockVercelSandboxEnvironment(() => ({ status: "finished", output: { ok: true, n: 7 } }));
      return {
        base,
        client: {
          create: async (opts) => {
            const sandbox = await base.create(opts);
            return new Proxy(sandbox, {
              get(target, prop) {
                if (prop === "readFile") {
                  return async (arg) => {
                    const buf = await target.readFile(arg);
                    return wrap(Buffer.from(buf).toString("utf-8"));
                  };
                }
                return Reflect.get(target, prop);
              },
            });
          },
        },
      };
    }

    test("decodes a { text() } result file", async () => {
      const { client } = envWithReadShape((str) => ({ text: async () => str }));
      const provider = createVercelSandboxProvider({ client, oidcToken: "t" });
      const result = await provider.run(makeRequest().request);
      expect(result).toMatchObject({ status: "finished", output: { ok: true, n: 7 } });
    });

    test("decodes a { content: Uint8Array } result file", async () => {
      const { client } = envWithReadShape((str) => ({ content: Buffer.from(str) }));
      const provider = createVercelSandboxProvider({ client, oidcToken: "t" });
      const result = await provider.run(makeRequest().request);
      expect(result).toMatchObject({ status: "finished", output: { ok: true, n: 7 } });
    });

    test("decodes a { content: string } result file", async () => {
      const { client } = envWithReadShape((str) => ({ content: str }));
      const provider = createVercelSandboxProvider({ client, oidcToken: "t" });
      const result = await provider.run(makeRequest().request);
      expect(result).toMatchObject({ status: "finished", output: { ok: true, n: 7 } });
    });

    test("falls back to String(value) for an unrecognized object shape", async () => {
      const { client } = envWithReadShape((str) => ({ toString: () => str }));
      const provider = createVercelSandboxProvider({ client, oidcToken: "t" });
      const result = await provider.run(makeRequest().request);
      expect(result).toMatchObject({ status: "finished", output: { ok: true, n: 7 } });
    });
  });

  describe("optional SDK loading via importSdk", () => {
    test("imports the SDK and runs when no client is injected", async () => {
      const env = createMockVercelSandboxEnvironment(() => ({ status: "finished", output: { loaded: true } }));
      const provider = createVercelSandboxProvider({
        oidcToken: "t",
        importSdk: async () => ({ Sandbox: env }),
      });
      const result = await provider.run(makeRequest().request);
      expect(result).toMatchObject({ status: "finished", output: { loaded: true } });
      expect(env.createCalls).toHaveLength(1);
    });

    test("a failing import produces an actionable install error", async () => {
      const provider = createVercelSandboxProvider({
        oidcToken: "t",
        importSdk: async () => {
          throw new Error("Cannot find package '@vercel/sandbox'");
        },
      });
      let error;
      try {
        await provider.run(makeRequest().request);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(SmithersError);
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toContain("@vercel/sandbox");
    });

    test("a module without a valid Sandbox export throws INVALID_INPUT", async () => {
      const provider = createVercelSandboxProvider({
        oidcToken: "t",
        importSdk: async () => ({ Sandbox: { notCreate: true } }),
      });
      let error;
      try {
        await provider.run(makeRequest().request);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(SmithersError);
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toContain("does not export");
    });
  });

  test("an exec failure is surfaced and options.env secrets are scrubbed", async () => {
    const secret = "svc-token-abc-123";
    const env = createMockVercelSandboxEnvironment(() => {
      throw new Error(`connection failed using ${secret}`);
    });
    const provider = createVercelSandboxProvider({ client: env, oidcToken: "t", env: { SERVICE_TOKEN: secret } });
    let error;
    try {
      await provider.run(makeRequest().request);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SmithersError);
    expect(error.code).toBe("SANDBOX_EXECUTION_FAILED");
    expect(error.message).not.toContain(secret);
  });
});

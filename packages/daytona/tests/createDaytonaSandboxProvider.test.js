import { describe, expect, test } from "bun:test";
import { DAYTONA_SANDBOX_PROVIDER_ID } from "../src/DAYTONA_SANDBOX_PROVIDER_ID.js";
import { createDaytonaSandboxProvider } from "../src/createDaytonaSandboxProvider.js";
import { createMockDaytonaSandboxEnvironment } from "../src/createMockDaytonaSandboxEnvironment.js";

let seq = 0;

/**
 * @param {Record<string, unknown>} [overrides]
 */
function makeRequest(overrides = {}) {
  const heartbeats = [];
  const n = seq++;
  const request = {
    runId: "run-1",
    sandboxId: "sbx-1",
    input: { topic: "daytona" },
    config: {},
    rootDir: `/tmp/daytona-${n}/root`,
    requestBundlePath: `/tmp/daytona-${n}/request`,
    resultBundlePath: `/tmp/daytona-${n}/result`,
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

describe("createDaytonaSandboxProvider", () => {
  test("default provider id", () => {
    const provider = createDaytonaSandboxProvider({
      client: createMockDaytonaSandboxEnvironment(() => ({ status: "finished" })),
    });
    expect(provider.id).toBe(DAYTONA_SANDBOX_PROVIDER_ID);
  });

  test("custom provider id", () => {
    const provider = createDaytonaSandboxProvider({
      id: "custom-daytona",
      client: createMockDaytonaSandboxEnvironment(() => ({ status: "finished" })),
    });
    expect(provider.id).toBe("custom-daytona");
  });

  test("empty command rejected", () => {
    expect(() =>
      createDaytonaSandboxProvider({
        command: "   ",
        client: createMockDaytonaSandboxEnvironment(() => ({ status: "finished" })),
      }),
    ).toThrow(/must not be empty/);
  });

  test("invalid cleanup rejected", () => {
    expect(() =>
      createDaytonaSandboxProvider({
        cleanup: "nope",
        client: createMockDaytonaSandboxEnvironment(() => ({ status: "finished" })),
      }),
    ).toThrow(/destroy.*keep|keep.*destroy/);
  });

  test("image and snapshot together rejected", () => {
    expect(() => createDaytonaSandboxProvider({ image: "ubuntu", snapshot: "snap-1" })).toThrow(
      /either image or snapshot/,
    );
  });

  test("injected client is used and receives create options", async () => {
    const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished", output: { ok: true } }));
    const provider = createDaytonaSandboxProvider({
      client: env,
      image: "ubuntu:22.04",
      labels: { app: "smithers" },
      resources: { cpu: 2, memory: 4 },
      autoStopInterval: 30,
      env: { HELLO: "world" },
    });
    const { request } = makeRequest();
    await provider.run(request);
    expect(env.createOptions[0]).toMatchObject({
      image: "ubuntu:22.04",
      envVars: { HELLO: "world" },
      labels: { app: "smithers" },
      resources: { cpu: 2, memory: 4 },
      autoStopInterval: 30,
      ephemeral: true,
    });
  });

  test("defaults: ephemeral true, autoStopInterval 15", async () => {
    const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createDaytonaSandboxProvider({ client: env });
    await provider.run(makeRequest().request);
    expect(env.createOptions[0]).toMatchObject({ ephemeral: true, autoStopInterval: 15 });
  });

  test("request.config maps image, snapshot, resources, labels", async () => {
    const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createDaytonaSandboxProvider({ client: env });
    await provider.run(
      makeRequest({
        config: { snapshot: "snap-42", resources: { cpu: 4 }, labels: { team: "core" } },
      }).request,
    );
    const opts = env.createOptions[0];
    expect(opts.snapshot).toBe("snap-42");
    expect(opts.image).toBeUndefined();
    expect(opts.resources).toEqual({ cpu: 4 });
    expect(opts.labels).toEqual({ team: "core" });
  });

  test("workspace config maps snapshotId, idleTimeoutSecs, ephemeral persistence", async () => {
    const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createDaytonaSandboxProvider({ client: env, ephemeral: false });
    await provider.run(
      makeRequest({
        config: { workspace: { snapshotId: "ws-snap", idleTimeoutSecs: 300, persistence: "ephemeral" } },
      }).request,
    );
    const opts = env.createOptions[0];
    expect(opts.snapshot).toBe("ws-snap");
    expect(opts.autoStopInterval).toBe(5);
    expect(opts.ephemeral).toBe(true);
  });

  test("workspace persistent config sets ephemeral false", async () => {
    const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createDaytonaSandboxProvider({ client: env });
    await provider.run(makeRequest({ config: { workspace: { persistence: "persistent" } } }).request);
    expect(env.createOptions[0].ephemeral).toBe(false);
  });

  test("request JSON reaches the sandbox with input + config", async () => {
    let seen;
    const env = createMockDaytonaSandboxEnvironment(({ request }) => {
      seen = request;
      return { status: "finished" };
    });
    const provider = createDaytonaSandboxProvider({ client: env });
    const { request } = makeRequest({ config: { flavor: "x" } });
    await provider.run(request);
    expect(seen.runId).toBe("run-1");
    expect(seen.input).toEqual({ topic: "daytona" });
    expect(seen.config).toEqual({ flavor: "x" });
  });

  test("exec env includes both Smithers path vars and options.env", async () => {
    let seen;
    const env = createMockDaytonaSandboxEnvironment(({ env: e }) => {
      seen = e;
      return { status: "finished" };
    });
    const provider = createDaytonaSandboxProvider({ client: env, env: { FLAG: "on" } });
    await provider.run(makeRequest().request);
    expect(typeof seen.SMITHERS_SANDBOX_REQUEST_PATH).toBe("string");
    expect(typeof seen.SMITHERS_SANDBOX_RESULT_PATH).toBe("string");
    expect(seen.FLAG).toBe("on");
  });

  test("result parsed from result-file with remote ids filled", async () => {
    const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished", output: { ok: true } }));
    const provider = createDaytonaSandboxProvider({ client: env });
    const result = await provider.run(makeRequest().request);
    expect(result.status).toBe("finished");
    expect(result.output).toEqual({ ok: true });
    expect(result.remoteRunId).toBe("daytona-mock-0");
    expect(result.workspaceId).toBe("daytona-mock-0");
    expect(result.containerId).toBe("daytona-mock-0");
  });

  test("session-created heartbeat carries remoteId", async () => {
    const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createDaytonaSandboxProvider({ client: env });
    const { request, heartbeats } = makeRequest();
    await provider.run(request);
    const created = heartbeats.find((h) => h?.stage === `${DAYTONA_SANDBOX_PROVIDER_ID}-session-created`);
    expect(created).toBeDefined();
    expect(created.remoteId).toBe("daytona-mock-0");
  });

  test("create failure surfaced and secret redacted", async () => {
    const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }), { failCreate: true });
    const provider = createDaytonaSandboxProvider({ client: env, env: { DAYTONA_API_KEY: "secret" } });
    let error;
    try {
      await provider.run(makeRequest().request);
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(error.message).toMatch(/creation failed/);
    expect(error.message).not.toContain("secret");
  });

  test("exec failure surfaced and secret redacted", async () => {
    const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }), { failExec: true });
    const provider = createDaytonaSandboxProvider({ client: env, env: { DAYTONA_TOKEN: "secret" } });
    let error;
    try {
      await provider.run(makeRequest().request);
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(error.code).toBe("SANDBOX_EXECUTION_FAILED");
    expect(error.message).not.toContain("secret");
  });

  test("invalid result JSON surfaces", async () => {
    const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createDaytonaSandboxProvider({ client: env });
    // Corrupt the result file after the handler writes it by intercepting downloadFile.
    const original = env.create.bind(env);
    env.create = async (opts) => {
      const sandbox = await original(opts);
      const upstream = sandbox.process.executeCommand.bind(sandbox.process);
      sandbox.process.executeCommand = async (...args) => {
        const res = await upstream(...args);
        const env2 = args[2] ?? {};
        sandbox.files.set(env2.SMITHERS_SANDBOX_RESULT_PATH, "{not json");
        return res;
      };
      return sandbox;
    };
    await expect(provider.run(makeRequest().request)).rejects.toThrow(/invalid result JSON/);
  });

  test("cleanup destroy tears down the remote sandbox", async () => {
    const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createDaytonaSandboxProvider({ client: env, cleanup: "destroy" });
    const { request } = makeRequest();
    await provider.run(request);
    await provider.cleanup?.(request);
    expect(env.sandboxes.get("daytona-mock-0").destroyed).toBe(true);
  });

  test("cleanup keep leaves the remote sandbox alive", async () => {
    const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createDaytonaSandboxProvider({ client: env, cleanup: "keep" });
    const { request } = makeRequest();
    await provider.run(request);
    await provider.cleanup?.(request);
    expect(env.sandboxes.get("daytona-mock-0").destroyed).toBe(false);
  });

  test("aborted signal fails the exec", async () => {
    const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createDaytonaSandboxProvider({ client: env });
    const controller = new AbortController();
    controller.abort();
    await expect(provider.run(makeRequest({ signal: controller.signal }).request)).rejects.toThrow();
  });

  test("normal exec removes its abort listener (no leak on a shared signal)", async () => {
    const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }));
    const provider = createDaytonaSandboxProvider({ client: env });
    const controller = new AbortController();
    const { signal } = controller;
    let added = 0;
    let removed = 0;
    const realAdd = signal.addEventListener.bind(signal);
    const realRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (type, ...rest) => {
      if (type === "abort") added++;
      return realAdd(type, ...rest);
    };
    signal.removeEventListener = (type, ...rest) => {
      if (type === "abort") removed++;
      return realRemove(type, ...rest);
    };
    // Reuse the same non-aborted signal across several execs (as a long-lived shared signal would be).
    for (let i = 0; i < 3; i++) {
      await provider.run(makeRequest({ signal }).request);
    }
    expect(added).toBeGreaterThan(0);
    expect(removed).toBe(added);
  });

  test("egress secrets are redacted in the shipped request JSON", async () => {
    let seen;
    const env = createMockDaytonaSandboxEnvironment(({ request }) => {
      seen = request;
      return { status: "finished" };
    });
    const provider = createDaytonaSandboxProvider({ client: env });
    await provider.run(
      makeRequest({
        egress: { httpsProxy: "https://proxy:8443", secretBindings: { PROXY_TOKEN: "super-secret" } },
      }).request,
    );
    expect(JSON.stringify(seen.egress)).not.toContain("super-secret");
  });

  test("create returning a sandbox without a string id fails", async () => {
    const client = { create: async () => ({}), delete: async () => {} };
    const provider = createDaytonaSandboxProvider({ client });
    await expect(provider.run(makeRequest().request)).rejects.toThrow(/did not return a sandbox with an id/);
  });

  test("waitUntilStarted is awaited when the sandbox is not yet started", async () => {
    let waited = false;
    const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished", output: { ok: true } }));
    const original = env.create.bind(env);
    env.create = async (opts) => {
      const sandbox = await original(opts);
      sandbox.state = "provisioning";
      const realWait = sandbox.waitUntilStarted.bind(sandbox);
      sandbox.waitUntilStarted = async () => {
        waited = true;
        return realWait();
      };
      return sandbox;
    };
    const provider = createDaytonaSandboxProvider({ client: env });
    const result = await provider.run(makeRequest().request);
    expect(waited).toBe(true);
    expect(result.status).toBe("finished");
    expect(result.output).toEqual({ ok: true });
  });

  test("waitUntilStarted failure tears down the sandbox and surfaces a redacted startup error", async () => {
    const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }));
    const original = env.create.bind(env);
    env.create = async (opts) => {
      const sandbox = await original(opts);
      sandbox.state = "provisioning";
      sandbox.waitUntilStarted = async () => {
        throw new Error("startup boom [DAYTONA_API_KEY=secret]");
      };
      return sandbox;
    };
    const provider = createDaytonaSandboxProvider({ client: env, env: { DAYTONA_API_KEY: "secret" } });
    let error;
    try {
      await provider.run(makeRequest().request);
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(error.code).toBe("SANDBOX_EXECUTION_FAILED");
    expect(error.message).toMatch(/startup failed/);
    expect(error.message).not.toContain("secret");
    expect(env.sandboxes.get("daytona-mock-0").destroyed).toBe(true);
  });

  test("exec aborts when the signal fires after the session is created", async () => {
    const controller = new AbortController();
    const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }));
    const original = env.create.bind(env);
    env.create = async (opts) => {
      const sandbox = await original(opts);
      const upload = sandbox.fs.uploadFile.bind(sandbox.fs);
      sandbox.fs.uploadFile = async (...args) => {
        controller.abort();
        return upload(...args);
      };
      return sandbox;
    };
    const provider = createDaytonaSandboxProvider({ client: env });
    await expect(provider.run(makeRequest({ signal: controller.signal }).request)).rejects.toThrow(
      /aborted before it started/,
    );
  });

  test("exec times out locally when the command never settles", async () => {
    const env = createMockDaytonaSandboxEnvironment(() => new Promise(() => {}));
    const provider = createDaytonaSandboxProvider({ client: env });
    const started = Date.now();
    let error;
    try {
      await provider.run(makeRequest({ toolTimeoutMs: 40 }).request);
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(error.code).toBe("SANDBOX_EXECUTION_FAILED");
    expect(error.message).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("importSdk providing a Daytona constructor is used to build the client", async () => {
    const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished", output: { built: true } }));
    const provider = createDaytonaSandboxProvider({
      importSdk: async () => ({
        Daytona: class {
          constructor() {
            return env;
          }
        },
      }),
    });
    const result = await provider.run(makeRequest().request);
    expect(result.status).toBe("finished");
    expect(result.output).toEqual({ built: true });
    expect(env.createOptions.length).toBe(1);
  });

  test("SDK without a Daytona constructor is rejected", async () => {
    const provider = createDaytonaSandboxProvider({ importSdk: async () => ({}) });
    await expect(provider.run(makeRequest().request)).rejects.toThrow(/does not export a Daytona client constructor/);
  });

  test("readFile decodes an object result via toString", async () => {
    const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }));
    const original = env.create.bind(env);
    env.create = async (opts) => {
      const sandbox = await original(opts);
      sandbox.fs.downloadFile = async () => ({
        toString() {
          return JSON.stringify({ status: "finished", output: { via: "toString" } });
        },
      });
      return sandbox;
    };
    const provider = createDaytonaSandboxProvider({ client: env });
    const result = await provider.run(makeRequest().request);
    expect(result.output).toEqual({ via: "toString" });
  });

  test("readFile of a non-decodable result yields an empty string and an invalid-result error", async () => {
    const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }));
    const original = env.create.bind(env);
    env.create = async (opts) => {
      const sandbox = await original(opts);
      sandbox.fs.downloadFile = async () => 42;
      return sandbox;
    };
    const provider = createDaytonaSandboxProvider({ client: env });
    await expect(provider.run(makeRequest().request)).rejects.toThrow();
  });

  test("create race rejects when the signal aborts mid-provisioning", async () => {
    const controller = new AbortController();
    const sandbox = { id: "slow", state: "started" };
    const client = {
      create: () => new Promise((resolve) => setTimeout(() => resolve(sandbox), 100)),
      delete: async () => {},
    };
    const provider = createDaytonaSandboxProvider({ client });
    const runPromise = provider.run(makeRequest({ signal: controller.signal }).request);
    setTimeout(() => controller.abort(), 10);
    let error;
    try {
      await runPromise;
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(error.code).toBe("SANDBOX_EXECUTION_FAILED");
    expect(error.message).toMatch(/creation failed/);
  });

  test("startup race short-circuits when the signal is already aborted by the state check", async () => {
    const controller = new AbortController();
    const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }));
    const original = env.create.bind(env);
    env.create = async (opts) => {
      const sandbox = await original(opts);
      // Abort the signal at the moment provider reads `state`, so the
      // waitUntilStarted race is entered with an already-aborted signal.
      Object.defineProperty(sandbox, "state", {
        get() {
          controller.abort();
          return "provisioning";
        },
      });
      return sandbox;
    };
    const provider = createDaytonaSandboxProvider({ client: env });
    let error;
    try {
      await provider.run(makeRequest({ signal: controller.signal }).request);
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(error.code).toBe("SANDBOX_EXECUTION_FAILED");
    expect(error.message).toMatch(/startup failed/);
    expect(env.sandboxes.get("daytona-mock-0").destroyed).toBe(true);
  });

  test("a sandbox that finishes provisioning after a timeout is cleaned up", async () => {
    let deleted;
    let onDeleted = () => {};
    const deletedPromise = new Promise((resolve) => {
      onDeleted = resolve;
    });
    const sandbox = { id: "slow-sandbox", state: "started" };
    const client = {
      create: () => new Promise((resolve) => setTimeout(() => resolve(sandbox), 50)),
      delete: async (sb) => {
        deleted = sb;
        onDeleted();
      },
    };
    const provider = createDaytonaSandboxProvider({ client });
    await expect(provider.run(makeRequest({ toolTimeoutMs: 10 }).request)).rejects.toThrow(/timed out/);
    await deletedPromise;
    expect(deleted).toBe(sandbox);
  });

  test("missing SDK produces an actionable install error", async () => {
    // Simulate the SDK not being installed via the injectable importer, so the
    // test is deterministic whether or not @daytonaio/sdk is present locally.
    const provider = createDaytonaSandboxProvider({
      importSdk: async () => {
        throw new Error("Cannot find package '@daytonaio/sdk'");
      },
    });
    await expect(provider.run(makeRequest().request)).rejects.toThrow(/@daytonaio\/sdk|not installed/);
  });
});

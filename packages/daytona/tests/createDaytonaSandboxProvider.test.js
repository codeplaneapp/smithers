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
		const provider = createDaytonaSandboxProvider({ client: createMockDaytonaSandboxEnvironment(() => ({ status: "finished" })) });
		expect(provider.id).toBe(DAYTONA_SANDBOX_PROVIDER_ID);
	});

	test("custom provider id", () => {
		const provider = createDaytonaSandboxProvider({ id: "custom-daytona", client: createMockDaytonaSandboxEnvironment(() => ({ status: "finished" })) });
		expect(provider.id).toBe("custom-daytona");
	});

	test("empty command rejected", () => {
		expect(() => createDaytonaSandboxProvider({ command: "   ", client: createMockDaytonaSandboxEnvironment(() => ({ status: "finished" })) })).toThrow(/must not be empty/);
	});

	test("invalid cleanup rejected", () => {
		expect(() => createDaytonaSandboxProvider({ cleanup: "nope", client: createMockDaytonaSandboxEnvironment(() => ({ status: "finished" })) })).toThrow(/destroy.*keep|keep.*destroy/);
	});

	test("image and snapshot together rejected", () => {
		expect(() => createDaytonaSandboxProvider({ image: "ubuntu", snapshot: "snap-1" })).toThrow(/either image or snapshot/);
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
		await provider.run(makeRequest({
			config: { snapshot: "snap-42", resources: { cpu: 4 }, labels: { team: "core" } },
		}).request);
		const opts = env.createOptions[0];
		expect(opts.snapshot).toBe("snap-42");
		expect(opts.image).toBeUndefined();
		expect(opts.resources).toEqual({ cpu: 4 });
		expect(opts.labels).toEqual({ team: "core" });
	});

	test("workspace config maps snapshotId, idleTimeoutSecs, ephemeral persistence", async () => {
		const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }));
		const provider = createDaytonaSandboxProvider({ client: env, ephemeral: false });
		await provider.run(makeRequest({
			config: { workspace: { snapshotId: "ws-snap", idleTimeoutSecs: 300, persistence: "ephemeral" } },
		}).request);
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
		await provider.run(makeRequest({
			egress: { httpsProxy: "https://proxy:8443", secretBindings: { PROXY_TOKEN: "super-secret" } },
		}).request);
		expect(JSON.stringify(seen.egress)).not.toContain("super-secret");
	});

	test("missing SDK produces an actionable install error", async () => {
		// No client injected + no SDK installed -> lazy import fails.
		const provider = createDaytonaSandboxProvider({});
		await expect(provider.run(makeRequest().request)).rejects.toThrow(/@daytonaio\/sdk|not installed/);
	});
});

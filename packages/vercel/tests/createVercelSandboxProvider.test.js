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
		const provider = createVercelSandboxProvider({ client: createMockVercelSandboxEnvironment(() => ({ status: "finished" })), oidcToken: "t" });
		expect(provider.id).toBe(VERCEL_SANDBOX_PROVIDER_ID);
	});

	test("accepts a custom provider id", () => {
		const provider = createVercelSandboxProvider({ id: "custom-vercel", client: createMockVercelSandboxEnvironment(() => ({ status: "finished" })), oidcToken: "t" });
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

	test("run rejects with INVALID_INPUT when no auth is configured", async () => {
		await withoutVercelEnv(async () => {
			const provider = createVercelSandboxProvider({
				client: createMockVercelSandboxEnvironment(() => ({ status: "finished" })),
			});
			const { request } = makeRequest();
			let error;
			try {
				await provider.run(request);
			} catch (e) {
				error = e;
			}
			expect(error).toBeInstanceOf(SmithersError);
			expect(error.code).toBe("INVALID_INPUT");
		});
	});

	test("prefers the OIDC token for auth", async () => {
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
			expect(env.createCalls[0].oidcToken).toBe("oidc-abc");
			expect(env.createCalls[0].token).toBeUndefined();
			expect(env.createCalls[0].teamId).toBeUndefined();
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
			expect(env.createCalls[0].oidcToken).toBeUndefined();
		});
	});

	test("reads OIDC token from the environment", async () => {
		await withoutVercelEnv(async () => {
			process.env.VERCEL_OIDC_TOKEN = "env-oidc";
			const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
			const provider = createVercelSandboxProvider({ client: env });
			await provider.run(makeRequest().request);
			expect(env.createCalls[0].oidcToken).toBe("env-oidc");
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
		expect(seenRequest).toMatchObject({ runId: "run-1", sandboxId: "sbx-1", input: { topic: "vercel" }, config: { model: "opus" } });
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
			expect(env.sandboxes[0].extendTimeoutCalls).toEqual([10 * 60_000]);
			const warn = heartbeats.find((h) => String(h?.stage ?? "").endsWith("-timeout-extend"));
			expect(warn).toBeDefined();
			expect(warn.level).toBe("warn");
			expect(warn.requestedMs).toBe(10 * 60_000);
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
			const provider = createVercelSandboxProvider({ client: env, oidcToken: "t", timeoutMs: 60 * 60_000, maxDurationMs: 90 * 60_000 });
			await provider.run(makeRequest().request);
			expect(env.sandboxes[0].extendTimeoutCalls).toEqual([60 * 60_000]);
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

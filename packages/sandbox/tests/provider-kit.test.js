import { describe, expect, test } from "bun:test";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import {
	createCommandSandboxProvider,
	parseSandboxProviderResult,
	redactSandboxProviderValue,
	SANDBOX_PROVIDER_REQUEST_ENV,
	SANDBOX_PROVIDER_RESULT_ENV,
	uploadEgressCaToSession,
} from "../src/provider-kit/index.js";
import { SANDBOX_EGRESS_CA_BUNDLE_RELATIVE_PATH } from "../src/egress.js";

/**
 * Build a fully controllable fake SandboxSession. Not a vendor mock: every
 * behavior (exec result, exec throw, destroy) is driven by the test.
 * @param {{
 *   remoteId?: string;
 *   exec?: (command: string, opts: import("../src/provider-kit/SandboxSession.ts").SandboxExecOptions) => import("../src/provider-kit/SandboxSession.ts").SandboxExecResult | Promise<import("../src/provider-kit/SandboxSession.ts").SandboxExecResult>;
 * }} [config]
 */
function makeSession(config = {}) {
	const files = new Map();
	const execCalls = [];
	let destroyed = 0;
	const session = {
		remoteId: config.remoteId ?? "remote-1",
		async writeFile(path, content) {
			files.set(path, content);
		},
		async readFile(path) {
			return files.get(path) ?? "";
		},
		async exec(command, opts) {
			execCalls.push({ command, opts });
			if (config.exec) {
				return await config.exec(command, opts);
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		},
		async destroy() {
			destroyed += 1;
		},
	};
	return {
		session,
		files,
		execCalls,
		destroyedCount: () => destroyed,
	};
}

/**
 * @param {Record<string, unknown>} [overrides]
 */
function makeRequest(overrides = {}) {
	const heartbeats = [];
	const request = {
		runId: "run-1",
		sandboxId: "sbx-1",
		input: { hello: "world" },
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

const REQUEST_PATH = "/workspace/.smithers/sandbox-request.json";
const RESULT_PATH = "/workspace/.smithers/sandbox-result.json";

describe("createCommandSandboxProvider", () => {
	test("writes the request JSON contents to the request file", async () => {
		const s = makeSession({
			exec: () => ({ exitCode: 0, stdout: JSON.stringify({ status: "finished" }), stderr: "" }),
		});
		const provider = createCommandSandboxProvider({ id: "kit", createSession: () => s.session });
		const { request } = makeRequest();
		await provider.run(request);
		const written = JSON.parse(s.files.get(REQUEST_PATH));
		expect(written.runId).toBe("run-1");
		expect(written.sandboxId).toBe("sbx-1");
		expect(written.input).toEqual({ hello: "world" });
		expect(written.config).toEqual({ model: "opus" });
		expect(written.allowNetwork).toBe(false);
		expect(written.maxOutputBytes).toBe(1_000_000);
	});

	test("injects both path env vars, egress env, and options.env with no process.env leakage", async () => {
		let seenEnv;
		const s = makeSession({
			exec: (_command, opts) => {
				seenEnv = opts.env;
				return { exitCode: 0, stdout: JSON.stringify({ status: "finished" }), stderr: "" };
			},
		});
		const provider = createCommandSandboxProvider({
			id: "kit",
			env: { CUSTOM_FLAG: "yes" },
			createSession: () => s.session,
		});
		const { request } = makeRequest({
			egress: { env: { EGRESS_VAR: "eg" }, httpsProxy: "https://proxy:9" },
		});
		await provider.run(request);
		expect(seenEnv[SANDBOX_PROVIDER_REQUEST_ENV]).toBe(REQUEST_PATH);
		expect(seenEnv[SANDBOX_PROVIDER_RESULT_ENV]).toBe(RESULT_PATH);
		expect(seenEnv.CUSTOM_FLAG).toBe("yes");
		expect(seenEnv.EGRESS_VAR).toBe("eg");
		expect(seenEnv.HTTPS_PROXY).toBe("https://proxy:9");
		// No arbitrary process.env keys leak in.
		expect(seenEnv.PATH).toBeUndefined();
		expect(Object.keys(seenEnv).sort()).toEqual([
			"CUSTOM_FLAG",
			"EGRESS_VAR",
			"HTTPS_PROXY",
			SANDBOX_PROVIDER_REQUEST_ENV,
			SANDBOX_PROVIDER_RESULT_ENV,
		].sort());
	});

	test("parses result from stdout when it starts with {", async () => {
		const s = makeSession({
			exec: () => ({ exitCode: 0, stdout: JSON.stringify({ status: "finished", output: 42 }), stderr: "" }),
		});
		const provider = createCommandSandboxProvider({ id: "kit", createSession: () => s.session });
		const { request } = makeRequest();
		const result = await provider.run(request);
		expect(result.status).toBe("finished");
		expect(result.output).toBe(42);
	});

	test("parses result from result file when stdout is not JSON", async () => {
		const s = makeSession({
			exec: async (_command, _opts) => {
				await s.session.writeFile(RESULT_PATH, JSON.stringify({ status: "failed", output: "nope" }));
				return { exitCode: 0, stdout: "log line noise", stderr: "" };
			},
		});
		const provider = createCommandSandboxProvider({ id: "kit", createSession: () => s.session });
		const { request } = makeRequest();
		const result = await provider.run(request);
		expect(result.status).toBe("failed");
		expect(result.output).toBe("nope");
	});

	test("bundlePath passthrough fills remote ids from session.remoteId", async () => {
		const s = makeSession({
			remoteId: "remote-xyz",
			exec: () => ({ exitCode: 0, stdout: JSON.stringify({ bundlePath: "/b" }), stderr: "" }),
		});
		const provider = createCommandSandboxProvider({ id: "kit", createSession: () => s.session });
		const { request } = makeRequest();
		const result = await provider.run(request);
		expect(result.bundlePath).toBe("/b");
		expect(result.remoteRunId).toBe("remote-xyz");
		expect(result.workspaceId).toBe("remote-xyz");
		expect(result.containerId).toBe("remote-xyz");
	});

	test("status/outputs passthrough", async () => {
		const s = makeSession({
			exec: () => ({ exitCode: 0, stdout: JSON.stringify({ status: "finished", outputs: { a: 1 } }), stderr: "" }),
		});
		const provider = createCommandSandboxProvider({ id: "kit", createSession: () => s.session });
		const { request } = makeRequest();
		const result = await provider.run(request);
		expect(result.status).toBe("finished");
		expect(result.outputs).toEqual({ a: 1 });
	});

	test("nonzero exit with non-JSON stdout throws with truncated+redacted stderr", async () => {
		const secret = "sk-supersecretvalue";
		const s = makeSession({
			exec: () => ({ exitCode: 3, stdout: "not json", stderr: `boom ${secret} ${"x".repeat(50)}` }),
		});
		const provider = createCommandSandboxProvider({
			id: "kit",
			env: { OPENAI_API_KEY: secret },
			createSession: () => s.session,
		});
		const { request } = makeRequest({ maxOutputBytes: 20 });
		let error;
		try {
			await provider.run(request);
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(SmithersError);
		expect(error.code).toBe("SANDBOX_EXECUTION_FAILED");
		expect(error.message).not.toContain(secret);
		expect(error.message).toContain("truncated");
	});

	test("nonzero exit but JSON stdout present is a success", async () => {
		const s = makeSession({
			exec: () => ({ exitCode: 7, stdout: JSON.stringify({ status: "finished" }), stderr: "warning" }),
		});
		const provider = createCommandSandboxProvider({ id: "kit", createSession: () => s.session });
		const { request } = makeRequest();
		const result = await provider.run(request);
		expect(result.status).toBe("finished");
	});

	test("empty stdout and empty result file throws", async () => {
		const s = makeSession({ exec: () => ({ exitCode: 0, stdout: "", stderr: "" }) });
		const provider = createCommandSandboxProvider({ id: "kit", createSession: () => s.session });
		const { request } = makeRequest();
		await expect(provider.run(request)).rejects.toBeInstanceOf(SmithersError);
	});

	test("malformed result JSON throws with a snippet", async () => {
		const s = makeSession({
			exec: () => ({ exitCode: 0, stdout: "{not valid json here", stderr: "" }),
		});
		const provider = createCommandSandboxProvider({ id: "kit", createSession: () => s.session });
		const { request } = makeRequest();
		let error;
		try {
			await provider.run(request);
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(SmithersError);
		expect(error.message).toContain("not valid json here");
	});

	test("toolTimeoutMs is forwarded to exec.timeoutMs", async () => {
		let seenOpts;
		const s = makeSession({
			exec: (_command, opts) => {
				seenOpts = opts;
				return { exitCode: 0, stdout: JSON.stringify({ status: "finished" }), stderr: "" };
			},
		});
		const provider = createCommandSandboxProvider({ id: "kit", createSession: () => s.session });
		const { request } = makeRequest({ toolTimeoutMs: 12345 });
		await provider.run(request);
		expect(seenOpts.timeoutMs).toBe(12345);
	});

	test("signal is forwarded to exec", async () => {
		let seenOpts;
		const s = makeSession({
			exec: (_command, opts) => {
				seenOpts = opts;
				return { exitCode: 0, stdout: JSON.stringify({ status: "finished" }), stderr: "" };
			},
		});
		const provider = createCommandSandboxProvider({ id: "kit", createSession: () => s.session });
		const controller = new AbortController();
		const { request } = makeRequest({ signal: controller.signal });
		await provider.run(request);
		expect(seenOpts.signal).toBe(controller.signal);
	});

	test("uploadEgressCaToSession writes CA only when caCertPem is set", async () => {
		const withCa = makeSession();
		const caPath = await uploadEgressCaToSession(withCa.session, { caCertPem: "PEMDATA" }, "/workspace");
		expect(caPath).toBe(`/workspace/${SANDBOX_EGRESS_CA_BUNDLE_RELATIVE_PATH}`);
		expect(withCa.files.get(caPath)).toBe("PEMDATA");

		const withoutCa = makeSession();
		const none = await uploadEgressCaToSession(withoutCa.session, {}, "/workspace");
		expect(none).toBeNull();
		expect(withoutCa.files.size).toBe(0);
	});

	test("run ships the CA bundle when egress carries caCertPem", async () => {
		const s = makeSession({
			exec: () => ({ exitCode: 0, stdout: JSON.stringify({ status: "finished" }), stderr: "" }),
		});
		const provider = createCommandSandboxProvider({ id: "kit", createSession: () => s.session });
		const { request } = makeRequest({ egress: { caCertPem: "MYPEM" } });
		await provider.run(request);
		expect(s.files.get(`/workspace/${SANDBOX_EGRESS_CA_BUNDLE_RELATIVE_PATH}`)).toBe("MYPEM");
	});

	test("secret value from options.env is scrubbed from a thrown exec error", async () => {
		const secret = "tok-abc-123-secret";
		const s = makeSession({
			exec: () => {
				throw new Error(`connection failed using ${secret}`);
			},
		});
		const provider = createCommandSandboxProvider({
			id: "kit",
			env: { SERVICE_TOKEN: secret },
			createSession: () => s.session,
		});
		const { request } = makeRequest();
		let error;
		try {
			await provider.run(request);
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(SmithersError);
		expect(error.message).not.toContain(secret);
		expect(error.message).toContain("[redacted]");
	});

	test("cleanup destroy calls session.destroy", async () => {
		const s = makeSession({
			exec: () => ({ exitCode: 0, stdout: JSON.stringify({ status: "finished" }), stderr: "" }),
		});
		const provider = createCommandSandboxProvider({ id: "kit", cleanup: "destroy", createSession: () => s.session });
		const { request } = makeRequest();
		await provider.run(request);
		await provider.cleanup(request);
		expect(s.destroyedCount()).toBe(1);
	});

	test("cleanup keep does not call session.destroy", async () => {
		const s = makeSession({
			exec: () => ({ exitCode: 0, stdout: JSON.stringify({ status: "finished" }), stderr: "" }),
		});
		const provider = createCommandSandboxProvider({ id: "kit", cleanup: "keep", createSession: () => s.session });
		const { request } = makeRequest();
		await provider.run(request);
		await provider.cleanup(request);
		expect(s.destroyedCount()).toBe(0);
	});

	test("cleanup for an unknown sandbox is a no-op", async () => {
		const provider = createCommandSandboxProvider({ id: "kit", createSession: () => makeSession().session });
		const { request } = makeRequest();
		await provider.cleanup(request);
	});

	test("cleanup twice is idempotent", async () => {
		const s = makeSession({
			exec: () => ({ exitCode: 0, stdout: JSON.stringify({ status: "finished" }), stderr: "" }),
		});
		const provider = createCommandSandboxProvider({ id: "kit", cleanup: "destroy", createSession: () => s.session });
		const { request } = makeRequest();
		await provider.run(request);
		await provider.cleanup(request);
		await provider.cleanup(request);
		expect(s.destroyedCount()).toBe(1);
	});

	test("run result is returned before a cleanup whose destroy throws, and cleanup rejects", async () => {
		const s = makeSession({
			exec: () => ({ exitCode: 0, stdout: JSON.stringify({ status: "finished", output: "ok" }), stderr: "" }),
		});
		s.session.destroy = async () => {
			throw new Error("destroy boom");
		};
		const provider = createCommandSandboxProvider({ id: "kit", cleanup: "destroy", createSession: () => s.session });
		const { request } = makeRequest();
		// The successful run result must come back intact BEFORE cleanup runs.
		const result = await provider.run(request);
		expect(result.status).toBe("finished");
		expect(result.output).toBe("ok");
		// cleanup must let the destroy rejection propagate so execute.js can downgrade it.
		await expect(provider.cleanup(request)).rejects.toThrow("destroy boom");
	});

	test("a destroy failure does not corrupt the active-session map; a second cleanup is a no-op", async () => {
		const s = makeSession({
			exec: () => ({ exitCode: 0, stdout: JSON.stringify({ status: "finished" }), stderr: "" }),
		});
		let destroyCalls = 0;
		s.session.destroy = async () => {
			destroyCalls += 1;
			throw new Error("destroy boom");
		};
		const provider = createCommandSandboxProvider({ id: "kit", cleanup: "destroy", createSession: () => s.session });
		const { request } = makeRequest();
		await provider.run(request);
		await expect(provider.cleanup(request)).rejects.toThrow("destroy boom");
		// The session was removed from the map before destroy ran, so a repeat cleanup finds nothing.
		await provider.cleanup(request);
		expect(destroyCalls).toBe(1);
	});

	test("egress secret and proxy credentials are scrubbed from a thrown exec error", async () => {
		const egressSecret = "egress-secret-value-xyz";
		const proxyUrl = "https://proxyuser:proxypass123@proxy.internal:8080";
		const s = makeSession({
			exec: () => {
				throw new Error(`failed talking to ${proxyUrl} using ${egressSecret}`);
			},
		});
		const provider = createCommandSandboxProvider({ id: "kit", createSession: () => s.session });
		const { request } = makeRequest({
			egress: { env: { SERVICE_SECRET: egressSecret }, httpsProxy: proxyUrl },
		});
		let error;
		try {
			await provider.run(request);
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(SmithersError);
		expect(error.message).not.toContain(egressSecret);
		expect(error.message).not.toContain(proxyUrl);
		expect(error.message).not.toContain("proxypass123");
		expect(error.message).toContain("[redacted]");
	});

	test("throws on empty id", () => {
		expect(() => createCommandSandboxProvider({ id: "  ", createSession: () => makeSession().session })).toThrow(SmithersError);
	});

	test("throws on missing createSession", () => {
		expect(() => createCommandSandboxProvider({ id: "kit" })).toThrow(SmithersError);
	});

	test("throws on empty command", () => {
		expect(() => createCommandSandboxProvider({ id: "kit", command: "   ", createSession: () => makeSession().session })).toThrow(SmithersError);
	});

	test("throws on bad cleanup mode", () => {
		expect(() => createCommandSandboxProvider({ id: "kit", cleanup: "burn", createSession: () => makeSession().session })).toThrow(SmithersError);
	});
});

describe("redactSandboxProviderValue", () => {
	test("redacts secret-looking keys and recurses", () => {
		const out = redactSandboxProviderValue({
			token: "abc",
			apiKey: "def",
			nested: { password: "p", ok: 1 },
			list: [{ secret: "s" }, "plain"],
			keep: "value",
		});
		expect(out.token).toBe("[redacted]");
		expect(out.apiKey).toBe("[redacted]");
		expect(out.nested.password).toBe("[redacted]");
		expect(out.nested.ok).toBe(1);
		expect(out.list[0].secret).toBe("[redacted]");
		expect(out.list[1]).toBe("plain");
		expect(out.keep).toBe("value");
	});

	test("handles cycles without looping", () => {
		const cyclic = { name: "root" };
		cyclic.self = cyclic;
		const out = redactSandboxProviderValue(cyclic);
		expect(out.name).toBe("root");
		expect(out.self).toBe("[Circular]");
	});

	test("returns primitives unchanged", () => {
		expect(redactSandboxProviderValue("x")).toBe("x");
		expect(redactSandboxProviderValue(5)).toBe(5);
		expect(redactSandboxProviderValue(null)).toBeNull();
	});
});

describe("parseSandboxProviderResult", () => {
	test("throws SmithersError on empty input", () => {
		expect(() => parseSandboxProviderResult("   ", "r1")).toThrow(SmithersError);
	});

	test("throws SmithersError with snippet on malformed JSON", () => {
		let error;
		try {
			parseSandboxProviderResult("{broken", "r1");
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(SmithersError);
		expect(error.message).toContain("{broken");
	});

	test("throws on non-object JSON", () => {
		expect(() => parseSandboxProviderResult("123", "r1")).toThrow(SmithersError);
	});

	test("fills remote ids from remoteId when absent", () => {
		const out = parseSandboxProviderResult(JSON.stringify({ status: "finished" }), "remote-9");
		expect(out.remoteRunId).toBe("remote-9");
		expect(out.workspaceId).toBe("remote-9");
		expect(out.containerId).toBe("remote-9");
	});

	test("prefers runId then explicit remote fields", () => {
		const out = parseSandboxProviderResult(JSON.stringify({ status: "finished", runId: "rr", workspaceId: "ws" }), "remote-9");
		expect(out.remoteRunId).toBe("rr");
		expect(out.workspaceId).toBe("ws");
		expect(out.containerId).toBe("remote-9");
	});

	test("rejects a result carrying both bundlePath and status (mutually exclusive)", () => {
		let error;
		try {
			parseSandboxProviderResult(JSON.stringify({ bundlePath: "/b", status: "finished" }), "r1");
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(SmithersError);
		expect(error.code).toBe("SANDBOX_EXECUTION_FAILED");
		expect(error.message).toContain("mutually exclusive");
	});

	test("accepts a bundlePath-only result", () => {
		const out = parseSandboxProviderResult(JSON.stringify({ bundlePath: "/b" }), "remote-9");
		expect(out.bundlePath).toBe("/b");
		expect(out.remoteRunId).toBe("remote-9");
	});

	test("accepts a status-only result", () => {
		const out = parseSandboxProviderResult(JSON.stringify({ status: "finished" }), "remote-9");
		expect(out.status).toBe("finished");
	});

	test("returns an unknown status value unchanged (execute.js is the authority that rejects it)", () => {
		const out = parseSandboxProviderResult(JSON.stringify({ status: "garbage-status" }), "remote-9");
		expect(out.status).toBe("garbage-status");
	});
});

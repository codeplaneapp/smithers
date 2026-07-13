import { describe, expect, test } from "bun:test";
import {
	createCloudflareSandboxProvider,
	createMockCloudflareSandboxEnvironment,
} from "../src/index.js";

/**
 * @param {Partial<import("@smithers-orchestrator/sandbox").SandboxProviderRequest>} [overrides]
 */
function makeRequest(overrides = {}) {
	return {
		runId: "run-1",
		sandboxId: "sandbox-1",
		input: {},
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
		...overrides,
	};
}

/**
 * Build a bespoke `getSandbox` returning a sandbox whose `exec`/`readFile`
 * behaviour is fully controlled, so we can drive the provider's result-decoding
 * branches.
 *
 * @param {{ exec?: (command: string) => unknown; readFile?: (path: string) => unknown; withMkdir?: boolean }} spec
 */
function customSandbox(spec) {
	const writes = [];
	const mkdirs = [];
	const sandbox = {
		writeFile(path, content) {
			writes.push({ path, content });
		},
		async readFile(path) {
			return spec.readFile ? spec.readFile(path) : { content: "" };
		},
		async exec(command) {
			return spec.exec ? spec.exec(command) : { success: true, exitCode: 0, stdout: "", stderr: "" };
		},
	};
	if (spec.withMkdir !== false) {
		sandbox.mkdir = async (path) => { mkdirs.push(path); };
	}
	return { getSandbox: () => sandbox, writes, mkdirs, sandbox };
}

describe("createCloudflareSandboxProvider validation", () => {
	test("throws when the command is empty", () => {
		expect(() => createCloudflareSandboxProvider({ command: "   " })).toThrow(
			"Cloudflare sandbox command must not be empty.",
		);
	});

	test("throws when no Durable Object binding resolves", async () => {
		const provider = createCloudflareSandboxProvider({
			getSandbox: () => ({}),
			binding: undefined,
		});
		await expect(provider.run(makeRequest())).rejects.toThrow(
			"Cloudflare sandbox provider requires a Durable Object binding.",
		);
	});

	test("resolves a function binding per-request", async () => {
		const env = createMockCloudflareSandboxEnvironment(async () => ({ status: "finished", output: { ok: 1 } }));
		const seen = [];
		const provider = createCloudflareSandboxProvider({
			getSandbox: env.getSandbox,
			binding: (request) => { seen.push(request.runId); return env.binding; },
			command: "node run.js",
		});
		const result = await provider.run(makeRequest());
		expect(seen).toEqual(["run-1"]);
		expect(result).toMatchObject({ status: "finished", output: { ok: 1 } });
	});
});

describe("createCloudflareSandboxProvider setup files", () => {
	test("writes nested setup files, creating their parent directories", async () => {
		const env = createMockCloudflareSandboxEnvironment(async () => ({ status: "finished", output: {} }));
		const provider = createCloudflareSandboxProvider({
			binding: env.binding,
			getSandbox: env.getSandbox,
			command: "node run.js",
			workdir: "/workspace",
			setupFiles: {
				"scripts/run.js": { content: "console.log(1)" },
				"/abs/config.json": { content: "{}", encoding: "utf-8" },
			},
		});
		await provider.run(makeRequest());
		const sandbox = env.sandboxes.get("run-1-sandbox-1");
		expect(sandbox.files.get("/workspace/scripts/run.js")).toBe("console.log(1)");
		expect(sandbox.files.get("/abs/config.json")).toBe("{}");
	});
});

describe("createCloudflareSandboxProvider directory creation", () => {
	test("swallows mkdir failures while still writing files and running", async () => {
		const writes = [];
		const sandbox = {
			async mkdir() {
				throw new Error("mkdir not permitted");
			},
			writeFile(path, content) {
				writes.push({ path, content });
			},
			async exec() {
				return { success: true, exitCode: 0, stdout: JSON.stringify({ status: "finished", output: {} }), stderr: "" };
			},
			async readFile() {
				return { content: "" };
			},
		};
		const provider = createCloudflareSandboxProvider({
			binding: {},
			getSandbox: () => sandbox,
			command: "node run.js",
			setupFiles: { "scripts/run.js": { content: "x" } },
		});
		const result = await provider.run(makeRequest());
		expect(result).toMatchObject({ status: "finished" });
		expect(writes.some((w) => w.path === "/workspace/scripts/run.js")).toBe(true);
	});
});

describe("createCloudflareSandboxProvider result decoding", () => {
	test("throws when the command exits non-zero", async () => {
		const { getSandbox } = customSandbox({
			exec: () => ({ success: false, exitCode: 2, stdout: "", stderr: "boom" }),
		});
		const provider = createCloudflareSandboxProvider({ binding: {}, getSandbox, command: "node run.js" });
		await expect(provider.run(makeRequest())).rejects.toThrow(
			'Cloudflare sandbox command "node run.js" exited with code 2: boom',
		);
	});

	test("throws when the command produces no result JSON", async () => {
		const { getSandbox } = customSandbox({
			exec: () => ({ success: true, exitCode: 0, stdout: "", stderr: "" }),
			// content is neither string, Uint8Array, nor ReadableStream => readFileContent() => ""
			readFile: () => ({ content: 42 }),
		});
		const provider = createCloudflareSandboxProvider({ binding: {}, getSandbox, command: "node run.js" });
		await expect(provider.run(makeRequest())).rejects.toThrow("produced no result JSON");
	});

	test("throws with a helpful message on invalid result JSON", async () => {
		const { getSandbox } = customSandbox({
			exec: () => ({ success: true, exitCode: 0, stdout: "{not-json", stderr: "" }),
		});
		const provider = createCloudflareSandboxProvider({ binding: {}, getSandbox, command: "node run.js" });
		await expect(provider.run(makeRequest())).rejects.toThrow("produced invalid result JSON");
	});

	for (const value of [null, "ok", 123, true]) {
		test(`throws a helpful message when result JSON is ${JSON.stringify(value)}`, async () => {
			const { getSandbox } = customSandbox({
				exec: () => ({ success: true, exitCode: 0, stdout: "", stderr: "" }),
				readFile: () => ({ content: JSON.stringify(value) }),
			});
			const provider = createCloudflareSandboxProvider({ binding: {}, getSandbox, command: "node run.js" });
			await expect(provider.run(makeRequest())).rejects.toThrow(
				"result JSON value that is not an object",
			);
		});
	}

	test("decodes result JSON read from a Uint8Array file", async () => {
		const payload = JSON.stringify({ status: "finished", output: { via: "bytes" } });
		const { getSandbox } = customSandbox({
			exec: () => ({ success: true, exitCode: 0, stdout: "", stderr: "" }),
			readFile: () => ({ content: new TextEncoder().encode(payload) }),
		});
		const provider = createCloudflareSandboxProvider({ binding: {}, getSandbox, command: "node run.js" });
		const result = await provider.run(makeRequest());
		expect(result).toMatchObject({
			status: "finished",
			output: { via: "bytes" },
			remoteRunId: "run-1-sandbox-1",
		});
	});

	test("decodes result JSON read from a ReadableStream file", async () => {
		const payload = JSON.stringify({ status: "finished", output: { via: "stream" } });
		const bytes = new TextEncoder().encode(payload);
		const { getSandbox } = customSandbox({
			exec: () => ({ success: true, exitCode: 0, stdout: "", stderr: "" }),
			readFile: () => ({
				content: new ReadableStream({
					start(controller) {
						controller.enqueue(bytes.slice(0, 5));
						controller.enqueue(bytes.slice(5));
						controller.close();
					},
				}),
			}),
		});
		const provider = createCloudflareSandboxProvider({ binding: {}, getSandbox, command: "node run.js" });
		const result = await provider.run(makeRequest());
		expect(result).toMatchObject({ status: "finished", output: { via: "stream" } });
	});

	test("passes through a bundlePath result and defaults its ids", async () => {
		const { getSandbox } = customSandbox({
			exec: () => ({
				success: true,
				exitCode: 0,
				stdout: JSON.stringify({ status: "finished", bundlePath: "/out/bundle.tar" }),
				stderr: "",
			}),
		});
		const provider = createCloudflareSandboxProvider({ binding: {}, getSandbox, command: "node run.js" });
		const result = await provider.run(makeRequest());
		expect(result).toMatchObject({
			status: "finished",
			bundlePath: "/out/bundle.tar",
			remoteRunId: "run-1-sandbox-1",
			workspaceId: "run-1-sandbox-1",
			containerId: "run-1-sandbox-1",
		});
	});

	test("bundlePath result keeps explicitly provided ids", async () => {
		const { getSandbox } = customSandbox({
			exec: () => ({
				success: true,
				exitCode: 0,
				stdout: JSON.stringify({
					status: "finished",
					bundlePath: "/out/bundle.tar",
					remoteRunId: "explicit-run",
					workspaceId: "explicit-ws",
					containerId: "explicit-container",
				}),
				stderr: "",
			}),
		});
		const provider = createCloudflareSandboxProvider({ binding: {}, getSandbox, command: "node run.js" });
		const result = await provider.run(makeRequest());
		expect(result).toMatchObject({
			remoteRunId: "explicit-run",
			workspaceId: "explicit-ws",
			containerId: "explicit-container",
		});
	});

	test("non-bundle result prefers parsed runId for remoteRunId", async () => {
		const { getSandbox } = customSandbox({
			exec: () => ({
				success: true,
				exitCode: 0,
				stdout: JSON.stringify({ status: "finished", runId: "inner-run", output: {} }),
				stderr: "",
			}),
		});
		const provider = createCloudflareSandboxProvider({ binding: {}, getSandbox, command: "node run.js" });
		const result = await provider.run(makeRequest());
		expect(result.remoteRunId).toBe("inner-run");
	});
});

describe("createCloudflareSandboxProvider getSandbox resolution", () => {
	test("uses an injected importer to resolve getSandbox()", async () => {
		let called = false;
		const provider = createCloudflareSandboxProvider({
			binding: {},
			command: "node run.js",
			importCloudflareSandbox: async () => ({
				getSandbox: () => {
					called = true;
					return {
						async mkdir() {},
						writeFile() {},
						async exec() {
							return { success: true, exitCode: 0, stdout: JSON.stringify({ status: "finished", output: {} }), stderr: "" };
						},
						async readFile() { return { content: "" }; },
					};
				},
			}),
		});
		const result = await provider.run(makeRequest());
		expect(called).toBe(true);
		expect(result).toMatchObject({ status: "finished" });
	});

	test("throws when the imported module lacks getSandbox()", async () => {
		const provider = createCloudflareSandboxProvider({
			binding: {},
			command: "node run.js",
			importCloudflareSandbox: async () => ({}),
		});
		await expect(provider.run(makeRequest())).rejects.toThrow(
			"@cloudflare/sandbox does not export getSandbox().",
		);
	});

	test("falls back to importing the real @cloudflare/sandbox module", async () => {
		const provider = createCloudflareSandboxProvider({ binding: {}, command: "node run.js" });
		// The real module pulls in `cloudflare:workers`, unavailable under Bun, so
		// the dynamic import rejects. This still drives the default import branch.
		await expect(provider.run(makeRequest())).rejects.toThrow();
	});
});

describe("createCloudflareSandboxProvider cleanup", () => {
	test("keeps the sandbox when cleanup is not 'destroy'", async () => {
		const env = createMockCloudflareSandboxEnvironment(async () => ({ status: "finished", output: {} }));
		const provider = createCloudflareSandboxProvider({
			binding: env.binding,
			getSandbox: env.getSandbox,
			command: "node run.js",
			cleanup: "keep",
		});
		await provider.run(makeRequest());
		await provider.cleanup?.(makeRequest());
		expect(env.sandboxes.get("run-1-sandbox-1").destroyed).toBe(false);
	});

	test("cleanup is a no-op for an unknown sandbox key", async () => {
		const provider = createCloudflareSandboxProvider({ binding: {}, getSandbox: () => ({}), command: "node run.js" });
		await expect(provider.cleanup?.(makeRequest({ runId: "never", sandboxId: "seen" }))).resolves.toBeUndefined();
	});
});

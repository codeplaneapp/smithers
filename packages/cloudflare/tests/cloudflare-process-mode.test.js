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

describe("createCloudflareSandboxProvider process mode failures", () => {
	test("throws when the detached process exits non-zero (via waitForExit)", async () => {
		const sandbox = {
			async mkdir() {},
			writeFile() {},
			async readFile() {
				return { content: "" };
			},
			async startProcess(command) {
				return {
					pid: 7,
					command,
					async waitForExit() {
						return { exitCode: 3 };
					},
				};
			},
		};
		const provider = createCloudflareSandboxProvider({
			binding: {},
			getSandbox: () => sandbox,
			command: "node run.js",
			execution: "process",
		});
		await expect(provider.run(makeRequest())).rejects.toThrow(
			'Cloudflare sandbox process "node run.js" exited with code 3 for sandbox "run-1-sandbox-1".',
		);
	});

	test("falls back to proc.exitCode when waitForExit is absent, throwing on non-zero", async () => {
		const sandbox = {
			async mkdir() {},
			writeFile() {},
			async readFile() {
				return { content: "" };
			},
			async startProcess(command) {
				return { pid: 8, command, exitCode: 5 };
			},
		};
		const provider = createCloudflareSandboxProvider({
			binding: {},
			getSandbox: () => sandbox,
			command: "node run.js",
			execution: "process",
		});
		await expect(provider.run(makeRequest())).rejects.toThrow(
			'exited with code 5',
		);
	});
});

describe("createMockCloudflareSandboxEnvironment process handle", () => {
	test("startProcess returns a completed handle whose lifecycle methods resolve", async () => {
		const env = createMockCloudflareSandboxEnvironment(async () => ({ status: "finished", output: { via: "process" } }));
		const sandbox = env.getSandbox(env.binding, "sbx");
		// Seed a request file so the handler input parses (mirrors provider behaviour).
		await sandbox.writeFile("/workspace/.smithers/sandbox-request.json", JSON.stringify({ runId: "r", sandboxId: "s" }));
		const proc = await sandbox.startProcess("node run.js");
		expect(proc).toMatchObject({ id: "sbx:process", pid: 1, command: "node run.js", status: "completed", exitCode: 0 });
		await expect(proc.waitForExit()).resolves.toEqual({ exitCode: 0 });
		await expect(proc.getStatus()).resolves.toBe("completed");
		await expect(proc.kill()).resolves.toBeUndefined();
		// The handler's result bundle was written to the workdir default path.
		const resultRaw = (await sandbox.readFile("/workspace/.smithers/sandbox-result.json")).content;
		expect(JSON.parse(resultRaw)).toMatchObject({ status: "finished", output: { via: "process" } });
	});

	test("startProcess throws once the sandbox is destroyed", async () => {
		const env = createMockCloudflareSandboxEnvironment(async () => ({ status: "finished", output: {} }));
		const sandbox = env.getSandbox(env.binding, "sbx-destroy");
		await sandbox.destroy();
		await expect(sandbox.startProcess("node run.js")).rejects.toThrow(
			'Mock Cloudflare sandbox "sbx-destroy" is destroyed.',
		);
	});
});

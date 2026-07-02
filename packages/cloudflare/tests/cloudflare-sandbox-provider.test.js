import { describe, expect, test } from "bun:test";
import {
	createCloudflareSandboxProvider,
	createMockCloudflareSandboxEnvironment,
} from "../src/index.js";

describe("createCloudflareSandboxProvider", () => {
	test("executes a Smithers sandbox request in a Cloudflare sandbox", async () => {
		const env = createMockCloudflareSandboxEnvironment(async ({ command, request, files }) => {
			expect(command).toBe("node /workspace/run.js");
			expect(request).toMatchObject({
				runId: "run-1",
				sandboxId: "sandbox-1",
				input: { topic: "cloudflare" },
			});
			expect([...files.keys()].some((path) => path.endsWith("sandbox-request.json"))).toBe(true);
			return { status: "finished", output: { ok: true } };
		});
		const provider = createCloudflareSandboxProvider({
			binding: env.binding,
			getSandbox: env.getSandbox,
			command: "node /workspace/run.js",
		});
		const heartbeats = [];
		const result = await provider.run({
			runId: "run-1",
			sandboxId: "sandbox-1",
			input: { topic: "cloudflare" },
			rootDir: "/tmp",
			requestBundlePath: "/tmp/request",
			resultBundlePath: "/tmp/result",
			workflow: { build: () => null },
			executeChildWorkflow: async () => ({ runId: "child", status: "finished", output: null }),
			allowNetwork: true,
			maxOutputBytes: 1024,
			toolTimeoutMs: 10_000,
			config: {},
			heartbeat: (data) => heartbeats.push(data),
		});

		expect(result).toEqual({
			status: "finished",
			output: { ok: true },
			remoteRunId: "run-1-sandbox-1",
			workspaceId: "run-1-sandbox-1",
			containerId: "run-1-sandbox-1",
		});
		expect(heartbeats[0]).toMatchObject({
			stage: "cloudflare-sandbox-created",
			remoteSandboxId: "run-1-sandbox-1",
		});

		await provider.cleanup?.({
			runId: "run-1",
			sandboxId: "sandbox-1",
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
		});
		expect(env.sandboxes.get("run-1-sandbox-1").destroyed).toBe(true);
	});

	test("can start a long-running process instead of waiting for a result bundle", async () => {
		const env = createMockCloudflareSandboxEnvironment(() => {
			throw new Error("exec should not be called");
		});
		const provider = createCloudflareSandboxProvider({
			binding: env.binding,
			getSandbox: env.getSandbox,
			execution: "process",
			command: "bun run worker.ts",
			cleanup: "keep",
		});
		const result = await provider.run({
			runId: "run-2",
			sandboxId: "worker",
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
		});
		expect(result).toMatchObject({
			status: "finished",
			output: { processId: "run-2-worker:process", status: "running" },
		});
	});
});

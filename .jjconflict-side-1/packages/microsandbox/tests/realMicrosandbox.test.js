import { expect, test } from "bun:test";
import { Sandbox } from "microsandbox";
import { createMicrosandboxSandboxProvider } from "../src/createMicrosandboxSandboxProvider.js";

const runner = `
const requestPath = process.env.SMITHERS_SANDBOX_REQUEST_PATH;
const resultPath = process.env.SMITHERS_SANDBOX_RESULT_PATH;
if (!requestPath || !resultPath) throw new Error("Smithers protocol paths are missing");
const request = await Bun.file(requestPath).json();
if (request.input?.marker !== "smithers-real-microsandbox") {
  throw new Error("Smithers request payload did not reach the guest");
}
await Bun.write(resultPath, JSON.stringify({
  status: "finished",
  output: {
    marker: request.input.marker,
    runId: request.runId,
    sandboxId: request.sandboxId,
    guestPlatform: process.platform,
  },
}));
`;

test(
	"published adapter executes the Smithers request/result protocol in a real guest",
	async () => {
		const sequence = `${process.pid}-${Date.now()}`;
		const sandboxName = `smithers-real-${sequence}`;
		const heartbeats = [];
		const request = {
			runId: `real-run-${sequence}`,
			sandboxId: "real-worker",
			input: { marker: "smithers-real-microsandbox" },
			config: {},
			rootDir: `/tmp/smithers-real-${sequence}`,
			requestBundlePath: `/tmp/smithers-real-${sequence}/request`,
			resultBundlePath: `/tmp/smithers-real-${sequence}/result`,
			workflow: { build: () => null },
			executeChildWorkflow: async () => ({ status: "finished" }),
			allowNetwork: false,
			maxOutputBytes: 1_000_000,
			toolTimeoutMs: 600_000,
			heartbeat: (value) => heartbeats.push(value),
		};
		const provider = createMicrosandboxSandboxProvider({
			sandboxName,
			image: "oven/bun:1",
			cpus: 1,
			memoryMib: 512,
			creationTimeoutMs: 600_000,
			stopTimeoutMs: 120_000,
			setupFiles: { "/workspace/run-smithers-sandbox.js": runner },
		});

		try {
			const result = await provider.run(request);
			expect(result.status).toBe("finished");
			expect(result.output).toEqual({
				marker: "smithers-real-microsandbox",
				runId: request.runId,
				sandboxId: request.sandboxId,
				guestPlatform: "linux",
			});
			expect(result.containerId).toBe(sandboxName);
			expect(heartbeats.map((entry) => entry.stage)).toEqual([
				"microsandbox-session-created",
				"microsandbox-request-shipped",
				"microsandbox-result-read",
			]);
		} finally {
			await provider.cleanup(request);
		}

		await expect(Sandbox.get(sandboxName)).rejects.toThrow();
	},
	900_000,
);

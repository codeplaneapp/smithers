import { describe, expect, test } from "bun:test";
import type { SandboxProviderRequest } from "smithers-orchestrator/sandbox";
import { createMockVercelSandboxClient, createVercelSandboxProvider } from "./provider.js";

function makeRequest(overrides: Partial<SandboxProviderRequest> = {}): SandboxProviderRequest {
	return {
		runId: "run-1",
		sandboxId: "sandbox-1",
		input: { prompt: "hello" },
		rootDir: "/repo",
		requestBundlePath: "/tmp/request-bundle",
		resultBundlePath: "/tmp/result-bundle",
		workflow: { build: () => null, opts: {} } as never,
		executeChildWorkflow: (async () => ({})) as never,
		allowNetwork: false,
		maxOutputBytes: 1_000_000,
		toolTimeoutMs: 60_000,
		config: {},
		heartbeat: () => {},
		...overrides,
	};
}

describe("createVercelSandboxProvider", () => {
	test("creates a sandbox, writes setup + request files, runs the command, and returns the result", async () => {
		const seenCommands: Array<{ cmd: string; args?: string[] }> = [];
		const mockVercelSandbox = createMockVercelSandboxClient(async ({ command, request }) => {
			seenCommands.push(command);
			return {
				status: "finished",
				output: { summary: `handled ${(request.input as { prompt: string }).prompt}` },
				runId: `vercel:${request.sandboxId}`,
			};
		});

		const provider = createVercelSandboxProvider({
			vercelSandbox: mockVercelSandbox,
			command: "node run.js",
			setupFiles: {
				"/vercel/sandbox/run.js": { content: "console.log('hi')" },
			},
		});

		const request = makeRequest();
		const result = await provider.run(request);

		expect(seenCommands).toEqual([{ cmd: "node", args: ["run.js"] }]);
		expect(result).toMatchObject({
			status: "finished",
			output: { summary: "handled hello" },
			remoteRunId: "vercel:sandbox-1",
			workspaceId: expect.stringContaining("mock-vercel-sandbox-"),
		});
	});

	test("stops the sandbox on cleanup", async () => {
		let stopped = false;
		const mockVercelSandbox = createMockVercelSandboxClient(async () => ({
			status: "finished",
			output: {},
			runId: "r",
		}));
		// Wrap create() to observe stop() without reaching into provider internals.
		const observedClient = {
			async create(options: Parameters<typeof mockVercelSandbox.create>[0]) {
				const handle = await mockVercelSandbox.create(options);
				const originalStop = handle.stop.bind(handle);
				handle.stop = async () => {
					stopped = true;
					return originalStop();
				};
				return handle;
			},
		};

		const provider = createVercelSandboxProvider({ vercelSandbox: observedClient });
		const request = makeRequest();
		await provider.run(request);
		await provider.cleanup?.(request);

		expect(stopped).toBe(true);
	});

	test("cleanup still stops the sandbox after a failed run", async () => {
		let stopped = false;
		const failingClient = createMockVercelSandboxClient(async () => {
			throw new Error("remote command failed");
		});
		const observedClient = {
			async create(options: Parameters<typeof failingClient.create>[0]) {
				const handle = await failingClient.create(options);
				const originalStop = handle.stop.bind(handle);
				handle.stop = async () => {
					stopped = true;
					return originalStop();
				};
				return handle;
			},
		};

		const provider = createVercelSandboxProvider({ vercelSandbox: observedClient });
		const request = makeRequest();

		await expect(provider.run(request)).rejects.toThrow();
		await provider.cleanup?.(request);

		expect(stopped).toBe(true);
	});

	test("does not attempt cleanup for a sandbox that was never created (no run() call)", async () => {
		const mockVercelSandbox = createMockVercelSandboxClient(async () => ({
			status: "finished",
			output: {},
			runId: "r",
		}));
		const provider = createVercelSandboxProvider({ vercelSandbox: mockVercelSandbox });
		// Should resolve without throwing even though run() was never called.
		await expect(provider.cleanup?.(makeRequest())).resolves.toBeUndefined();
	});
});

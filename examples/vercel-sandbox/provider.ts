import type {
	SandboxProvider,
	SandboxProviderRequest,
	SandboxProviderResult,
} from "smithers-orchestrator/sandbox";

// Minimal shape of the real `@vercel/sandbox` SDK surface this provider uses.
// Verified against the JS SDK reference (https://vercel.com/docs/sandbox/sdk-reference,
// fetched 2026-07-01) rather than guessed: `Sandbox.create()`, `sandbox.runCommand()`,
// `sandbox.writeFiles()`, `sandbox.readFileToBuffer()`, and `sandbox.stop()`/`sandbox.delete()`.
export type VercelCommandFinished = {
	exitCode: number;
	stdout(): Promise<string>;
	stderr(): Promise<string>;
};

export type VercelSandboxSource =
	| { type: "git"; url: string; username?: string; password?: string; depth?: number; revision?: string }
	| { type: "tarball"; url: string }
	| { type: "snapshot"; snapshotId: string };

export type VercelSandboxCreateOptions = {
	name?: string;
	source?: VercelSandboxSource;
	runtime?: string;
	timeout?: number;
	env?: Record<string, string>;
	resources?: { vcpus?: number };
};

export type VercelSandboxHandle = {
	name: string;
	runCommand(params: {
		cmd: string;
		args?: string[];
		cwd?: string;
		env?: Record<string, string>;
	}): Promise<VercelCommandFinished>;
	writeFiles(files: Array<{ path: string; content: Buffer; mode?: number }>): Promise<void>;
	readFileToBuffer(file: { path: string; cwd?: string }): Promise<Buffer | null>;
	stop(): Promise<unknown>;
};

// `Sandbox.create` is a static method on the SDK's `Sandbox` class, so the
// provider takes the class (or a drop-in stand-in, e.g. the mock below) as
// its single required dependency, mirroring how `createFreestyleSandboxProvider`
// takes a `freestyle` client object.
export type VercelSandboxClient = {
	create(options: VercelSandboxCreateOptions): Promise<VercelSandboxHandle>;
};

export type VercelSandboxProviderOptions = {
	vercelSandbox: VercelSandboxClient;
	command?: string;
	runtime?: string;
	timeout?: number;
	createOptions?: VercelSandboxCreateOptions;
	setupFiles?: Record<string, { content: string; mode?: number }>;
	cleanup?: "stop" | "keep";
};

const WORKDIR = "/vercel/sandbox";

function requestPath() {
	return `${WORKDIR}/smithers-request.json`;
}

function resultPath() {
	return `${WORKDIR}/smithers-result.json`;
}

function keyFor(request: SandboxProviderRequest) {
	return `${request.runId}:${request.sandboxId}`;
}

function parseResultJson(raw: string): SandboxProviderResult {
	const parsed = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object") {
		throw new Error("Vercel sandbox result must be a JSON object.");
	}
	return parsed as SandboxProviderResult;
}

/**
 * Builds a Smithers `SandboxProvider` backed by Vercel Sandbox
 * (`@vercel/sandbox`). `@vercel/sandbox` is NOT a dependency of this example
 * (or of any core Smithers package) — it stays an optional/peer dependency
 * the caller installs and wires in via `vercelSandbox`.
 *
 * Auth follows the SDK's own resolution: `VERCEL_OIDC_TOKEN` locally/on
 * Vercel, or `VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID` for access-token
 * auth (e.g. external CI). Neither this provider nor Smithers reads those env
 * vars directly — `Sandbox.create()` does.
 */
export function createVercelSandboxProvider(
	options: VercelSandboxProviderOptions,
): SandboxProvider {
	const command = options.command ?? "node /vercel/sandbox/run-smithers-sandbox.js";
	const cleanup = options.cleanup ?? "stop";
	const activeSandboxes = new Map<string, VercelSandboxHandle>();

	return {
		id: "vercel-sandbox",
		async run(request) {
			const createOptions = options.createOptions ?? {};
			const sandbox = await options.vercelSandbox.create({
				...createOptions,
				runtime: options.runtime ?? createOptions.runtime,
				timeout: options.timeout ?? createOptions.timeout,
			});
			activeSandboxes.set(keyFor(request), sandbox);

			request.heartbeat({
				sandboxId: request.sandboxId,
				stage: "vercel-sandbox-created",
				sandboxName: sandbox.name,
			});

			const setupFiles = Object.entries(options.setupFiles ?? {}).map(([path, file]) => ({
				path,
				content: Buffer.from(file.content, "utf8"),
				mode: file.mode,
			}));
			await sandbox.writeFiles([
				...setupFiles,
				{
					path: requestPath(),
					content: Buffer.from(
						JSON.stringify({
							runId: request.runId,
							sandboxId: request.sandboxId,
							input: request.input,
						}),
						"utf8",
					),
				},
			]);

			const [cmd, ...args] = command.split(" ");
			const finished = await sandbox.runCommand({ cmd, args });
			const stdout = (await finished.stdout()).trim();
			if (finished.exitCode !== 0) {
				const stderr = await finished.stderr();
				throw new Error(
					`Vercel sandbox command "${command}" exited with code ${finished.exitCode}: ${stderr || stdout}`,
				);
			}

			const result = stdout.startsWith("{")
				? parseResultJson(stdout)
				: parseResultJson(
						(await sandbox.readFileToBuffer({ path: resultPath() }))?.toString("utf8") ?? "",
					);

			if ("bundlePath" in result) {
				return {
					...result,
					remoteRunId: result.remoteRunId ?? sandbox.name,
					workspaceId: result.workspaceId ?? sandbox.name,
				};
			}
			return {
				...result,
				remoteRunId: result.remoteRunId ?? result.runId ?? sandbox.name,
				workspaceId: result.workspaceId ?? sandbox.name,
			};
		},
		async cleanup(request) {
			const sandbox = activeSandboxes.get(keyFor(request));
			if (!sandbox) {
				return;
			}
			activeSandboxes.delete(keyFor(request));
			if (cleanup !== "stop") {
				return;
			}
			// `stop()` resolves once the VM is fully stopped; safe to call even
			// after a failed run so a crashed/aborted sandbox doesn't keep billing.
			await sandbox.stop();
		},
	};
}

/**
 * A mock `@vercel/sandbox`-shaped client for tests and typechecking without
 * real credentials or network access, mirroring `createMockFreestyleClient`.
 */
export function createMockVercelSandboxClient(
	handler: (args: {
		command: { cmd: string; args?: string[] };
		request: { runId: string; sandboxId: string; input?: unknown };
		files: Map<string, Buffer>;
	}) => Promise<SandboxProviderResult> | SandboxProviderResult,
): VercelSandboxClient {
	let nextId = 0;
	return {
		async create() {
			nextId += 1;
			const name = `mock-vercel-sandbox-${nextId}`;
			const files = new Map<string, Buffer>();
			let stopped = false;
			const handle: VercelSandboxHandle = {
				name,
				async writeFiles(writtenFiles) {
					for (const file of writtenFiles) {
						files.set(file.path, file.content);
					}
				},
				async runCommand(params) {
					if (stopped) {
						throw new Error(`Mock Vercel sandbox "${name}" is stopped.`);
					}
					const request = JSON.parse(files.get(requestPath())?.toString("utf8") ?? "{}");
					const result = await handler({ command: params, request, files });
					files.set(resultPath(), Buffer.from(JSON.stringify(result), "utf8"));
					return {
						exitCode: 0,
						async stdout() {
							return "";
						},
						async stderr() {
							return "";
						},
					};
				},
				async readFileToBuffer(file) {
					return files.get(file.path) ?? null;
				},
				async stop() {
					stopped = true;
					return { snapshot: undefined, activeCpuUsageMs: 0, networkTransfer: { ingress: 0, egress: 0 } };
				},
			};
			return handle;
		},
	};
}

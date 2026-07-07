export const CLOUDFLARE_SANDBOX_PROVIDER_ID = "cloudflare-sandbox";

const DEFAULT_WORKDIR = "/workspace";
// Contract with the in-sandbox entry command: it reads the request JSON and
// writes the result JSON at these workdir-relative paths (also handed to it via
// SMITHERS_SANDBOX_REQUEST_PATH / SMITHERS_SANDBOX_RESULT_PATH).
const DEFAULT_REQUEST_FILE = ".smithers/sandbox-request.json";
const DEFAULT_RESULT_FILE = ".smithers/sandbox-result.json";

/**
 * @param {string} path
 * @returns {string}
 */
function dirname(path) {
	const index = path.lastIndexOf("/");
	return index <= 0 ? "/" : path.slice(0, index);
}

/**
 * @param {string} workdir
 * @param {string} path
 * @returns {string}
 */
function absolutePath(workdir, path) {
	return path.startsWith("/") ? path : `${workdir.replace(/\/+$/g, "")}/${path.replace(/^\/+/g, "")}`;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>[]}
 */
function rowsFromSqlCursor(value) {
	if (!value) return [];
	if (Array.isArray(value)) return /** @type {Record<string, unknown>[]} */ (value);
	if (typeof /** @type {{ toArray?: unknown }} */ (value).toArray === "function") {
		return /** @type {{ toArray: () => Record<string, unknown>[] }} */ (value).toArray();
	}
	return [];
}

/**
 * @param {unknown} value
 * @returns {unknown[][]}
 */
function valuesFromSqlCursor(value) {
	if (!value) return [];
	if (typeof /** @type {{ raw?: unknown }} */ (value).raw === "function") {
		const raw = /** @type {{ raw: () => Iterable<unknown[]> }} */ (value).raw();
		return Array.from(raw);
	}
	return rowsFromSqlCursor(value).map((row) => Object.values(row));
}

/**
 * Build a Smithers SQLite descriptor backed by a SQLite Durable Object storage
 * instance (`ctx.storage`) or its `ctx.storage.sql` handle.
 *
 * @param {{ sql?: { exec: (statement: string, ...params: unknown[]) => unknown }; transaction?: <T>(operation: () => T | Promise<T>) => T | Promise<T> } | { exec: (statement: string, ...params: unknown[]) => unknown }} storage
 */
export function createCloudflareDurableObjectSqliteDescriptor(storage) {
	const sql = "sql" in storage && storage.sql ? storage.sql : storage;
	const transaction = "transaction" in storage && typeof storage.transaction === "function"
		? storage.transaction.bind(storage)
		: undefined;
	return {
		dialect: "sqlite",
		driver: "cloudflare-sqlite",
		queryAllRaw(statement, params = []) {
			return rowsFromSqlCursor(sql.exec(statement, ...params));
		},
		queryValuesRaw(statement, params = []) {
			return valuesFromSqlCursor(sql.exec(statement, ...params));
		},
		execute(statement, params = []) {
			sql.exec(statement, ...params);
			return [];
		},
		transaction,
	};
}

/**
 * Build a Smithers SQLite descriptor backed by a Cloudflare D1 database.
 *
 * WARNING — D1 has NO interactive transactions. Its prepare/bind/run API cannot
 * hold an open BEGIN/COMMIT/ROLLBACK across round-trips, so the `transaction()`
 * returned here runs the operation directly with NO atomicity: a failure or
 * crash partway through leaves the earlier writes committed. Smithers'
 * run-of-record durability (frame commits — `insertFrame` + `captureSnapshot`,
 * run-state checkpoints, task completion) assumes transactional writes, so on
 * the D1 backend a mid-transaction failure can leave partial state. For durable
 * workflow state use `createCloudflareDurableObjectSqliteDescriptor`, which
 * binds the real `storage.transaction`; reserve D1 for read-mostly /
 * non-transactional use. `database.batch()` is not a substitute: the
 * transaction bodies are interactive read-then-write (e.g. read the current
 * event seq, then insert), which a fixed batch array cannot express.
 *
 * @param {{ prepare: (statement: string) => { bind: (...params: unknown[]) => { all: () => Promise<{ results?: Record<string, unknown>[] }>; raw?: () => Promise<unknown[][]>; run: () => Promise<unknown> } } }} database
 */
export function createCloudflareD1SqliteDescriptor(database) {
	return {
		dialect: "sqlite",
		driver: "cloudflare-sqlite",
		async queryAllRaw(statement, params = []) {
			const result = await database.prepare(statement).bind(...params).all();
			return result.results ?? [];
		},
		async queryValuesRaw(statement, params = []) {
			const prepared = database.prepare(statement).bind(...params);
			if (typeof prepared.raw === "function") {
				return await prepared.raw();
			}
			const result = await prepared.all();
			return (result.results ?? []).map((row) => Object.values(row));
		},
		async execute(statement, params = []) {
			await database.prepare(statement).bind(...params).run();
			return [];
		},
		async transaction(operation) {
			// D1 has no interactive transactions (see this function's JSDoc): this
			// runs the operation with no BEGIN/COMMIT/ROLLBACK and is NOT atomic.
			// Kept as a pass-through so read-mostly D1 usage still works.
			return await operation();
		},
	};
}

/**
 * @param {unknown} value
 * @returns {Promise<string>}
 */
async function readFileContent(value) {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return "";
	const content = /** @type {{ content?: unknown }} */ (value).content;
	if (typeof content === "string") return content;
	if (content instanceof Uint8Array) return new TextDecoder().decode(content);
	if (content instanceof ReadableStream) {
		const chunks = [];
		const reader = content.getReader();
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			chunks.push(next.value);
		}
		return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
	}
	return "";
}

/**
 * @returns {Promise<(binding: unknown, sandboxId: string, options?: Record<string, unknown>) => unknown>}
 */
async function resolveCloudflareGetSandbox() {
	const mod = await import("@cloudflare/sandbox");
	if (typeof mod.getSandbox !== "function") {
		throw new Error("@cloudflare/sandbox does not export getSandbox().");
	}
	return mod.getSandbox;
}

/**
 * Parse a sandbox run's result JSON and stamp the remote identifiers. Shared by
 * exec and process execution modes so both reconcile the same way.
 *
 * @param {string} rawResult
 * @param {{ command: string; remoteSandboxId: string; resultPath: string }} ctx
 */
function parseCloudflareSandboxResult(rawResult, { command, remoteSandboxId, resultPath }) {
	if (rawResult.trim() === "") {
		throw new Error(`Cloudflare sandbox command "${command}" produced no result JSON for sandbox "${remoteSandboxId}": the workflow entry must write result JSON to ${resultPath} (via SMITHERS_SANDBOX_RESULT_PATH) or print it to stdout.`);
	}
	let parsed;
	try {
		parsed = JSON.parse(rawResult);
	} catch (error) {
		throw new Error(`Cloudflare sandbox command "${command}" produced invalid result JSON for sandbox "${remoteSandboxId}" at ${resultPath}: ${error instanceof Error ? error.message : String(error)}. Raw output: ${rawResult.slice(0, 500)}`);
	}
	const remoteRunId = "bundlePath" in parsed
		? parsed.remoteRunId ?? remoteSandboxId
		: parsed.remoteRunId ?? parsed.runId ?? remoteSandboxId;
	return {
		...parsed,
		remoteRunId,
		workspaceId: parsed.workspaceId ?? remoteSandboxId,
		containerId: parsed.containerId ?? remoteSandboxId,
	};
}

/**
 * Builds a Smithers SandboxProvider backed by Cloudflare Sandbox SDK.
 *
 * @param {{
 *   binding?: unknown | ((request: import("@smithers-orchestrator/sandbox").SandboxProviderRequest) => unknown);
 *   getSandbox?: (binding: unknown, sandboxId: string, options?: Record<string, unknown>) => any;
 *   id?: string;
 *   sandboxId?: (request: import("@smithers-orchestrator/sandbox").SandboxProviderRequest) => string;
 *   sandboxOptions?: Record<string, unknown>;
 *   keepAlive?: boolean;
 *   sleepAfter?: string | number;
 *   workdir?: string;
 *   command?: string;
 *   env?: Record<string, string>;
 *   setupFiles?: Record<string, { content: string; encoding?: "utf-8" | "base64" }>;
 *   execution?: "exec" | "process";
 *   cleanup?: "destroy" | "keep";
 * }} options
 * @returns {import("@smithers-orchestrator/sandbox").SandboxProvider}
 */
export function createCloudflareSandboxProvider(options = {}) {
	const id = options.id ?? CLOUDFLARE_SANDBOX_PROVIDER_ID;
	const workdir = options.workdir ?? DEFAULT_WORKDIR;
	const command = (options.command ?? "node /workspace/run-smithers-sandbox.js").trim();
	if (!command) throw new Error("Cloudflare sandbox command must not be empty.");
	const cleanup = options.cleanup ?? "destroy";
	const active = new Map();

	return {
		id,
		async run(request) {
			const getSandbox = options.getSandbox ?? await resolveCloudflareGetSandbox();
			const binding = typeof options.binding === "function" ? options.binding(request) : options.binding;
			if (!binding) {
				throw new Error("Cloudflare sandbox provider requires a Durable Object binding.");
			}
			const remoteSandboxId = options.sandboxId?.(request) ?? `${request.runId}-${request.sandboxId}`;
			const sandbox = getSandbox(binding, remoteSandboxId, {
				enableDefaultSession: false,
				...(options.sandboxOptions ?? {}),
				keepAlive: options.keepAlive ?? options.sandboxOptions?.keepAlive,
				// Idle-hibernation window; the main container cost lever. Falls back
				// to the Sandbox SDK default (~10m) when neither is set.
				sleepAfter: options.sleepAfter ?? options.sandboxOptions?.sleepAfter,
			});
			active.set(`${request.runId}:${request.sandboxId}`, sandbox);
			request.heartbeat({ sandboxId: request.sandboxId, stage: "cloudflare-sandbox-created", remoteSandboxId });

			if (typeof sandbox.mkdir === "function") {
				await sandbox.mkdir(workdir).catch(() => {});
				await sandbox.mkdir(absolutePath(workdir, ".smithers")).catch(() => {});
			}
			for (const [path, file] of Object.entries(options.setupFiles ?? {})) {
				const target = absolutePath(workdir, path);
				if (typeof sandbox.mkdir === "function") {
					await sandbox.mkdir(dirname(target)).catch(() => {});
				}
				await sandbox.writeFile(target, file.content, { encoding: file.encoding ?? "utf-8" });
			}

			const requestPath = absolutePath(workdir, DEFAULT_REQUEST_FILE);
			const resultPath = absolutePath(workdir, DEFAULT_RESULT_FILE);
			await sandbox.writeFile(requestPath, JSON.stringify({
				runId: request.runId,
				sandboxId: request.sandboxId,
				input: request.input,
				config: request.config,
			}));

			const env = {
				...(options.env ?? {}),
				SMITHERS_SANDBOX_REQUEST_PATH: requestPath,
				SMITHERS_SANDBOX_RESULT_PATH: resultPath,
			};
			if (options.execution === "process") {
				const proc = await sandbox.startProcess(command, {
					cwd: workdir,
					env,
					timeout: request.toolTimeoutMs,
				});
				request.heartbeat({ sandboxId: request.sandboxId, stage: "cloudflare-sandbox-process-started", remoteSandboxId, pid: proc.pid });
				// A SandboxProvider.run() must return the run RESULT, not a bare pid.
				// Wait for the detached process to exit, then reconcile the result
				// bundle exactly like exec mode. (Previously this returned
				// status:"finished" with only a pid and never collected a result —
				// a silent success trap: the engine got no output/diff back.)
				const exit = typeof proc.waitForExit === "function"
					? await proc.waitForExit(request.toolTimeoutMs)
					: undefined;
				const exitCode = Number(exit?.exitCode ?? proc.exitCode ?? 0);
				if (exitCode !== 0) {
					throw new Error(`Cloudflare sandbox process "${command}" exited with code ${exitCode} for sandbox "${remoteSandboxId}".`);
				}
				const rawProcessResult = await readFileContent(await sandbox.readFile(resultPath));
				return parseCloudflareSandboxResult(rawProcessResult, { command, remoteSandboxId, resultPath });
			}

			const result = await sandbox.exec(command, {
				cwd: workdir,
				env,
				timeout: request.toolTimeoutMs,
			});
			const stdout = String(result.stdout ?? "").trim();
			if (!result.success && Number(result.exitCode ?? 1) !== 0) {
				throw new Error(`Cloudflare sandbox command "${command}" exited with code ${result.exitCode ?? 1}: ${result.stderr || stdout}`);
			}
			const rawResult = stdout.startsWith("{")
				? stdout
				: await readFileContent(await sandbox.readFile(resultPath));
			return parseCloudflareSandboxResult(rawResult, { command, remoteSandboxId, resultPath });
		},
		async cleanup(request) {
			const key = `${request.runId}:${request.sandboxId}`;
			const sandbox = active.get(key);
			active.delete(key);
			if (!sandbox || cleanup !== "destroy") return;
			if (typeof sandbox.destroy === "function") {
				await sandbox.destroy();
			}
		},
	};
}

/**
 * Test helper that implements the subset of the Cloudflare Sandbox SDK used by
 * `createCloudflareSandboxProvider`.
 *
 * @param {(args: { command: string; request: { runId: string; sandboxId: string; input?: unknown; config?: unknown }; files: Map<string, string> }) => import("@smithers-orchestrator/sandbox").SandboxProviderResult | Promise<import("@smithers-orchestrator/sandbox").SandboxProviderResult>} handler
 */
export function createMockCloudflareSandboxEnvironment(handler) {
	const sandboxes = new Map();
	const getSandbox = (_binding, sandboxId) => {
		if (sandboxes.has(sandboxId)) return sandboxes.get(sandboxId);
		const files = new Map();
		let destroyed = false;
		const sandbox = {
			id: sandboxId,
			files,
			get destroyed() {
				return destroyed;
			},
			async mkdir() {},
			async writeFile(path, content) {
				files.set(path, String(content));
			},
			async readFile(path) {
				return { content: files.get(path) ?? "" };
			},
			async exec(command) {
				if (destroyed) throw new Error(`Mock Cloudflare sandbox "${sandboxId}" is destroyed.`);
				const requestEntry = [...files.entries()].find(([path]) => path.endsWith(DEFAULT_REQUEST_FILE));
				const request = JSON.parse(requestEntry?.[1] ?? "{}");
				const result = await handler({ command, request, files });
				const resultPath = [...files.keys()].find((path) => path.endsWith(DEFAULT_RESULT_FILE)) ??
					absolutePath(DEFAULT_WORKDIR, DEFAULT_RESULT_FILE);
				files.set(resultPath, JSON.stringify(result));
				return { success: true, exitCode: 0, stdout: "", stderr: "" };
			},
			async startProcess(command) {
				if (destroyed) throw new Error(`Mock Cloudflare sandbox "${sandboxId}" is destroyed.`);
				// Model a detached process that runs to completion: invoke the
				// handler, write its result bundle, and expose waitForExit() so the
				// provider can reconcile it (mirrors @cloudflare/sandbox's Process).
				const requestEntry = [...files.entries()].find(([path]) => path.endsWith(DEFAULT_REQUEST_FILE));
				const request = JSON.parse(requestEntry?.[1] ?? "{}");
				const result = await handler({ command, request, files });
				const resultPath = [...files.keys()].find((path) => path.endsWith(DEFAULT_RESULT_FILE)) ??
					absolutePath(DEFAULT_WORKDIR, DEFAULT_RESULT_FILE);
				files.set(resultPath, JSON.stringify(result));
				return {
					id: `${sandboxId}:process`,
					pid: 1,
					command,
					status: "completed",
					exitCode: 0,
					async waitForExit() {
						return { exitCode: 0 };
					},
					async getStatus() {
						return "completed";
					},
					async kill() {},
				};
			},
			async destroy() {
				destroyed = true;
			},
		};
		sandboxes.set(sandboxId, sandbox);
		return sandbox;
	};
	return { binding: {}, getSandbox, sandboxes };
}

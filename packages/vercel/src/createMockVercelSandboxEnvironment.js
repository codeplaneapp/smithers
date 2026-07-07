import { Readable } from "node:stream";

const REQUEST_FILE = ".smithers/sandbox-request.json";
const RESULT_FILE = ".smithers/sandbox-result.json";

/**
 * In-memory double for the subset of the `@vercel/sandbox` SDK that
 * `createVercelSandboxProvider` exercises. This is what lets CI run with ZERO
 * Vercel credentials: pass the returned object as `options.client`.
 *
 * The command-execution path parses the shipped request JSON file, invokes the
 * contract `handler`, writes the returned value as JSON to the result file, and
 * returns a finished command whose `stdout()`/`stderr()` are async and whose
 * `exitCode` is 0.
 *
 * `Sandbox.create` in the real SDK takes `{ token, teamId?, projectId? }` (no
 * `oidcToken`); this double records whatever options it is handed via
 * `createCalls` without asserting a shape. When `config.streamReads` is set,
 * `readFile` resolves a Node `Readable` (matching the real 2.x
 * `Promise<NodeJS.ReadableStream | null>`) instead of a `Buffer`.
 *
 * @param {(args: {
 *   command: string;
 *   request: Record<string, unknown>;
 *   files: Map<string, string>;
 *   env: Record<string, string>;
 * }) => unknown} handler
 * @param {{
 *   fail?: string | string[];
 *   sandboxIdPrefix?: string;
 *   onDestroy?: () => void;
 *   streamReads?: boolean;
 * }} [config]
 */
export function createMockVercelSandboxEnvironment(handler, config = {}) {
	const failures = new Set(Array.isArray(config.fail) ? config.fail : config.fail ? [config.fail] : []);
	const prefix = config.sandboxIdPrefix ?? "vercel-sandbox";
	const sandboxes = [];
	const createCalls = [];
	let counter = 0;

	const create = async (createOptions) => {
		createCalls.push(createOptions);
		if (failures.has("create")) {
			throw new Error("mock vercel Sandbox.create failure");
		}
		counter += 1;
		const sandboxId = `${prefix}-${counter}`;
		/** @type {Map<string, string>} */
		const files = new Map();
		const extendTimeoutCalls = [];
		const domainCalls = [];
		let stopped = false;
		let deleted = false;
		let runCommandCalls = 0;
		/** @type {Record<string, unknown> | undefined} */
		let lastRunInput;

		const sandbox = {
			sandboxId,
			files,
			createOptions,
			extendTimeoutCalls,
			domainCalls,
			get runCommandCalls() {
				return runCommandCalls;
			},
			get lastRunInput() {
				return lastRunInput;
			},
			get stopped() {
				return stopped;
			},
			get deleted() {
				return deleted;
			},
			get destroyed() {
				return stopped || deleted;
			},
			async writeFiles(list) {
				if (failures.has("writeFiles")) throw new Error("mock vercel writeFiles failure");
				if (stopped || deleted) throw new Error(`mock vercel sandbox "${sandboxId}" is torn down`);
				for (const entry of list ?? []) {
					files.set(entry.path, bufferToString(entry.content));
				}
			},
			async readFile({ path }) {
				if (failures.has("readFile")) throw new Error("mock vercel readFile failure");
				const content = files.get(path) ?? "";
				// The real 2.x readFile resolves a Node ReadableStream; opt into that
				// shape so the provider's stream decode path is exercised end-to-end.
				if (config.streamReads) return Readable.from([Buffer.from(content)]);
				return Buffer.from(content);
			},
			async runCommand(runInput) {
				runCommandCalls += 1;
				lastRunInput = runInput;
				const { cmd, args, cwd, env } = runInput ?? {};
				if (stopped || deleted) throw new Error(`mock vercel sandbox "${sandboxId}" is torn down`);
				if (failures.has("exec") || failures.has("runCommand")) {
					throw new Error("mock vercel runCommand failure");
				}
				const command = Array.isArray(args) && args.length > 0 ? args[args.length - 1] : cmd;
				const requestEntry = [...files.entries()].find(([path]) => path.endsWith(REQUEST_FILE));
				const request = JSON.parse(requestEntry?.[1] ?? "{}");
				const result = await handler({ command, request, files, env: env ?? {} });
				const requestPath = requestEntry?.[0];
				const resultPath = requestPath && requestPath.endsWith(REQUEST_FILE)
					? `${requestPath.slice(0, -REQUEST_FILE.length)}${RESULT_FILE}`
					: `${(cwd ?? "").replace(/\/+$/g, "")}/${RESULT_FILE}`;
				files.set(resultPath, JSON.stringify(result));
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
			async extendTimeout(ms) {
				extendTimeoutCalls.push(ms);
			},
			domain(port) {
				domainCalls.push(port);
				return `https://${sandboxId}-${port}.vercel.run`;
			},
			async stop() {
				stopped = true;
				config.onDestroy?.();
			},
			async delete() {
				deleted = true;
				config.onDestroy?.();
			},
		};
		sandboxes.push(sandbox);
		return sandbox;
	};

	return { create, createCalls, sandboxes };
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function bufferToString(content) {
	if (typeof content === "string") return content;
	if (content instanceof Uint8Array) return Buffer.from(content).toString("utf-8");
	if (content && typeof content === "object" && typeof (/** @type {{ toString?: unknown }} */ (content).toString) === "function") {
		return String(content);
	}
	return String(content ?? "");
}

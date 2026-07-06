import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { createCommandSandboxProvider } from "@smithers-orchestrator/sandbox";
import { DAYTONA_SANDBOX_PROVIDER_ID } from "./DAYTONA_SANDBOX_PROVIDER_ID.js";

const DEFAULT_AUTO_STOP_INTERVAL_MINUTES = 15;
const SECRET_KEY_RE = /token|secret|key|password|credential|authorization|passwd|apikey/i;

/**
 * Build a Smithers SandboxProvider backed by the Daytona SDK.
 *
 * The provider-kit owns the request/result protocol, egress, secret scrubbing,
 * and cleanup; this factory only supplies a `createSession` that maps the small
 * SandboxSession seam onto a Daytona sandbox (`daytona.create`, `sandbox.fs`,
 * `sandbox.process.executeCommand`, `daytona.delete`).
 *
 * @param {import("./DaytonaSandboxProviderOptions.ts").DaytonaSandboxProviderOptions} [options]
 * @returns {import("@smithers-orchestrator/sandbox").SandboxProvider}
 */
export function createDaytonaSandboxProvider(options = {}) {
	const id = options.id ?? DAYTONA_SANDBOX_PROVIDER_ID;
	if (options.image && options.snapshot) {
		throw new SmithersError(
			"INVALID_INPUT",
			"Daytona sandbox provider accepts either image or snapshot, not both.",
			{ provider: id },
		);
	}

	return createCommandSandboxProvider({
		id,
		command: options.command,
		workdir: options.workdir,
		env: options.env,
		cleanup: options.cleanup,
		createSession: async (request) => {
			// The kit only scrubs secrets around the exec path; createSession runs
			// before that, so redact create-time errors ourselves.
			const secrets = secretValuesFrom(options);
			const client = await resolveDaytonaClient(options, id);
			const createOptions = resolveDaytonaCreateOptions(options, request);
			let sandbox;
			try {
				sandbox = await client.create(createOptions);
			} catch (error) {
				throw new SmithersError(
					"SANDBOX_EXECUTION_FAILED",
					`Daytona sandbox creation failed: ${scrubSecrets(messageOf(error), secrets)}`,
					{ provider: id },
				);
			}
			if (!sandbox || typeof sandbox.id !== "string") {
				throw new SmithersError(
					"SANDBOX_EXECUTION_FAILED",
					"Daytona create() did not return a sandbox with an id.",
					{ provider: id },
				);
			}
			// Newer SDKs return an already-running sandbox from create(); older
			// ones require an explicit wait before exec.
			if (sandbox.state !== "started" && typeof sandbox.waitUntilStarted === "function") {
				await sandbox.waitUntilStarted();
			}
			const remoteId = sandbox.id;

			return {
				remoteId,
				async writeFile(path, content) {
					await sandbox.fs.uploadFile(Buffer.from(String(content)), path);
				},
				async readFile(path) {
					const data = await sandbox.fs.downloadFile(path);
					return decodeToString(data);
				},
				async exec(command, { cwd, env, timeoutMs, signal }) {
					if (signal?.aborted) {
						throw new Error("Daytona sandbox command aborted before it started.");
					}
					const timeoutSecs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.ceil(timeoutMs / 1000) : 0;
					const execPromise = Promise.resolve(sandbox.process.executeCommand(command, cwd, env, timeoutSecs));
					const res = signal ? await raceWithAbort(execPromise, signal) : await execPromise;
					// Daytona merges stderr into result; there is no separate stream.
					return { exitCode: res?.exitCode ?? 0, stdout: String(res?.result ?? ""), stderr: "" };
				},
				async destroy() {
					await client.delete(sandbox);
				},
			};
		},
	});
}

/**
 * @param {import("./DaytonaSandboxProviderOptions.ts").DaytonaSandboxProviderOptions} options
 * @param {string} id
 * @returns {Promise<import("./DaytonaSandboxProviderOptions.ts").DaytonaClientLike>}
 */
async function resolveDaytonaClient(options, id) {
	if (options.client) {
		return options.client;
	}
	const Daytona = await loadDaytonaSdk(id);
	const clientOptions = options.clientOptions ?? {};
	return new Daytona({
		apiKey: options.apiKey ?? clientOptions.apiKey ?? process.env.DAYTONA_API_KEY,
		apiUrl: options.apiUrl ?? clientOptions.apiUrl ?? process.env.DAYTONA_API_URL,
		target: options.target ?? clientOptions.target ?? process.env.DAYTONA_TARGET,
	});
}

/**
 * Lazily load the Daytona SDK. The package is being renamed from
 * `@daytonaio/sdk` to `@daytona/sdk`, so try both before failing.
 *
 * @param {string} id
 * @returns {Promise<new (options: import("./DaytonaSandboxProviderOptions.ts").DaytonaClientOptions) => import("./DaytonaSandboxProviderOptions.ts").DaytonaClientLike>}
 */
async function loadDaytonaSdk(id) {
	let mod;
	try {
		mod = await import("@daytonaio/sdk");
	} catch {
		try {
			mod = await import("@daytona/sdk");
		} catch (error) {
			throw new SmithersError(
				"INVALID_INPUT",
				`Daytona SDK is not installed. Run "npm install @daytonaio/sdk" (or pass options.client). Original error: ${messageOf(error)}`,
				{ provider: id },
			);
		}
	}
	const Daytona = mod?.Daytona ?? mod?.default?.Daytona ?? mod?.default;
	if (typeof Daytona !== "function") {
		throw new SmithersError(
			"INVALID_INPUT",
			"Daytona SDK does not export a Daytona client constructor.",
			{ provider: id },
		);
	}
	return Daytona;
}

/**
 * Map factory options + `<Sandbox workspace>`-style config into `daytona.create`
 * options. `request.config` may carry `image`/`snapshot`/`resources`/`labels`
 * directly, or a `workspace` block (`snapshotId`, `idleTimeoutSecs`,
 * `persistence`).
 *
 * @param {import("./DaytonaSandboxProviderOptions.ts").DaytonaSandboxProviderOptions} options
 * @param {import("@smithers-orchestrator/sandbox").SandboxProviderRequest} request
 * @returns {import("./DaytonaSandboxProviderOptions.ts").DaytonaCreateOptions}
 */
function resolveDaytonaCreateOptions(options, request) {
	const config = request.config ?? {};
	const workspace = /** @type {Record<string, unknown>} */ (config.workspace ?? {});

	const snapshot = pickString(config.snapshot) ?? pickString(workspace.snapshotId) ?? options.snapshot;
	const image = snapshot ? undefined : (pickString(config.image) ?? options.image);

	let autoStopInterval = options.autoStopInterval ?? DEFAULT_AUTO_STOP_INTERVAL_MINUTES;
	const idleTimeoutSecs = pickNumber(workspace.idleTimeoutSecs);
	if (idleTimeoutSecs !== undefined) {
		autoStopInterval = Math.max(1, Math.ceil(idleTimeoutSecs / 60));
	}

	let ephemeral = options.ephemeral ?? true;
	if (workspace.persistence === "ephemeral") {
		ephemeral = true;
	} else if (workspace.persistence === "persistent") {
		ephemeral = false;
	}

	const labels = { ...(options.labels ?? {}), ...(asStringRecord(config.labels) ?? {}) };
	const resources = asResources(config.resources) ?? options.resources;

	/** @type {import("./DaytonaSandboxProviderOptions.ts").DaytonaCreateOptions} */
	const createOptions = {
		envVars: options.env,
		labels: Object.keys(labels).length > 0 ? labels : undefined,
		ephemeral,
		autoStopInterval,
	};
	if (snapshot) createOptions.snapshot = snapshot;
	if (image) createOptions.image = image;
	if (resources) createOptions.resources = resources;
	return createOptions;
}

/** @param {unknown} value @returns {string | undefined} */
function pickString(value) {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** @param {unknown} value @returns {number | undefined} */
function pickNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** @param {unknown} value @returns {Record<string, string> | undefined} */
function asStringRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	/** @type {Record<string, string>} */
	const out = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") out[key] = entry;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** @param {unknown} value @returns {import("./DaytonaSandboxProviderOptions.ts").DaytonaResources | undefined} */
function asResources(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = /** @type {Record<string, unknown>} */ (value);
	/** @type {import("./DaytonaSandboxProviderOptions.ts").DaytonaResources} */
	const resources = {};
	if (pickNumber(record.cpu) !== undefined) resources.cpu = /** @type {number} */ (record.cpu);
	if (pickNumber(record.memory) !== undefined) resources.memory = /** @type {number} */ (record.memory);
	if (pickNumber(record.disk) !== undefined) resources.disk = /** @type {number} */ (record.disk);
	return Object.keys(resources).length > 0 ? resources : undefined;
}

/** @param {unknown} data @returns {string} */
function decodeToString(data) {
	if (typeof data === "string") return data;
	if (data instanceof Uint8Array) return new TextDecoder().decode(data);
	if (data && typeof data === "object" && typeof (/** @type {{ toString?: unknown }} */ (data).toString) === "function") {
		return String(data);
	}
	return "";
}

/**
 * Race an exec promise against an AbortSignal, guaranteeing the abort listener
 * is removed once the exec settles (resolve or reject). Without the explicit
 * removeEventListener, a long-lived shared signal would leak one listener per
 * exec, since `{ once: true }` only detaches when the abort event actually fires.
 *
 * @template T
 * @param {Promise<T>} execPromise
 * @param {AbortSignal} signal
 * @returns {Promise<T>}
 */
function raceWithAbort(execPromise, signal) {
	/** @type {() => void} */
	let onAbort = () => {};
	const abortPromise = /** @type {Promise<never>} */ (
		new Promise((_resolve, reject) => {
			onAbort = () => reject(new Error("Daytona sandbox command aborted."));
			signal.addEventListener("abort", onAbort, { once: true });
		})
	);
	return Promise.race([execPromise, abortPromise]).finally(() => {
		signal.removeEventListener("abort", onAbort);
	});
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Collect secret-looking values (env values + apiKey) to scrub from error text.
 *
 * @param {import("./DaytonaSandboxProviderOptions.ts").DaytonaSandboxProviderOptions} options
 * @returns {string[]}
 */
function secretValuesFrom(options) {
	const out = [];
	for (const [key, value] of Object.entries(options.env ?? {})) {
		if (SECRET_KEY_RE.test(key) && typeof value === "string" && value.length > 0) out.push(value);
	}
	for (const value of [options.apiKey, options.clientOptions?.apiKey]) {
		if (typeof value === "string" && value.length > 0) out.push(value);
	}
	return out;
}

/**
 * @param {string} text
 * @param {string[]} secrets
 * @returns {string}
 */
function scrubSecrets(text, secrets) {
	let out = text;
	for (const secret of secrets) {
		out = out.split(secret).join("[redacted]");
	}
	return out;
}

import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { createCommandSandboxProvider, redactSandboxProviderValue } from "@smithers-orchestrator/sandbox";
import { VERCEL_SANDBOX_PROVIDER_ID } from "./VERCEL_SANDBOX_PROVIDER_ID.js";

const DEFAULT_WORKDIR = "/vercel/sandbox";
const DEFAULT_RUNTIME = "node24";
// Vercel caps the timeout you can request when creating a sandbox; longer
// durations must be reached incrementally with extendTimeout(). We use 5 min as
// the create-time ceiling and default session length.
const DEFAULT_SESSION_TIMEOUT_MS = 5 * 60_000;
// Plan/billing safety cap: refuse to provision a sandbox longer than this.
const DEFAULT_MAX_DURATION_MS = 45 * 60_000;
const SECRET_KEY_RE = /token|secret|key|password|credential|authorization|passwd|apikey/i;

/**
 * Build a Smithers SandboxProvider backed by the Vercel Sandbox SDK.
 *
 * The heavy lifting (request shipping, egress, result parsing, secret scrubbing,
 * cleanup) is owned by `createCommandSandboxProvider`; this factory only
 * implements the Vercel-specific `createSession` seam: auth selection, duration
 * mapping with plan-cap enforcement, port domain surfacing, and delete-vs-stop
 * teardown.
 *
 * @param {import("./VercelSandboxProviderOptions.ts").VercelSandboxProviderOptions} [options]
 * @returns {import("@smithers-orchestrator/sandbox").SandboxProvider}
 */
export function createVercelSandboxProvider(options = {}) {
	const id = options.id ?? VERCEL_SANDBOX_PROVIDER_ID;
	const persist = options.persist === true;
	const runtime = options.runtime ?? DEFAULT_RUNTIME;
	const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
	if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
		throw new SmithersError("INVALID_INPUT", "Vercel sandbox maxDurationMs must be a positive number of milliseconds.", { provider: id });
	}
	if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
		throw new SmithersError("INVALID_INPUT", "Vercel sandbox timeoutMs must be a positive number of milliseconds.", { provider: id });
	}

	return createCommandSandboxProvider({
		id,
		command: options.command,
		workdir: options.workdir ?? DEFAULT_WORKDIR,
		env: options.env,
		cleanup: options.cleanup,
		async createSession(request) {
			// Resolve + validate auth BEFORE touching the SDK so a misconfigured
			// provider fails fast with an actionable INVALID_INPUT.
			const auth = resolveVercelAuth(options, id);
			const secrets = collectSecrets(options, auth);
			const Sandbox = options.client ?? (await loadVercelSandbox(id));

			const desiredMs = options.timeoutMs ?? request.toolTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
			if (desiredMs > maxDurationMs) {
				throw new SmithersError(
					"INVALID_INPUT",
					`Vercel sandbox requested duration ${desiredMs}ms exceeds the plan cap of ${maxDurationMs}ms. Lower toolTimeoutMs/timeoutMs or raise options.maxDurationMs.`,
					{ provider: id, requestedMs: desiredMs, capMs: maxDurationMs },
				);
			}
			const createTimeoutMs = Math.min(desiredMs, DEFAULT_SESSION_TIMEOUT_MS);

			let sandbox;
			try {
				sandbox = await Sandbox.create({
					runtime,
					// Only send `resources` when a vcpu count is set; otherwise the SDK
					// receives `{ vcpus: undefined }`, which some versions reject.
					...(options.vcpus !== undefined ? { resources: { vcpus: options.vcpus } } : {}),
					// Provision the sandbox with any declared ports so their domains are
					// reachable (sandbox.domain(port) alone does not open them).
					...(Array.isArray(options.ports) && options.ports.length > 0 ? { ports: options.ports } : {}),
					timeout: createTimeoutMs,
					...(options.createOptions ?? {}),
					...auth,
				});
			} catch (error) {
				throw new SmithersError(
					"SANDBOX_EXECUTION_FAILED",
					`Vercel sandbox creation failed: ${scrubSecrets(messageOf(error), secrets)}`,
					{ provider: id },
				);
			}

			const remoteId = typeof sandbox.sandboxId === "string" && sandbox.sandboxId.length > 0
				? sandbox.sandboxId
				: `${request.runId}-${request.sandboxId}`;

			// Reach durations beyond the create ceiling by extending, up to the cap.
			if (desiredMs > createTimeoutMs) {
				request.heartbeat(redactSandboxProviderValue({
					sandboxId: request.sandboxId,
					stage: `${id}-timeout-extend`,
					level: "warn",
					remoteId,
					requestedMs: desiredMs,
					createTimeoutMs,
					capMs: maxDurationMs,
				}));
				if (typeof sandbox.extendTimeout === "function") {
					await sandbox.extendTimeout(desiredMs);
				}
			}

			// Surface reachable domains for any declared ports.
			if (Array.isArray(options.ports) && options.ports.length > 0 && typeof sandbox.domain === "function") {
				const domains = {};
				for (const port of options.ports) {
					domains[String(port)] = sandbox.domain(port);
				}
				request.heartbeat(redactSandboxProviderValue({
					sandboxId: request.sandboxId,
					stage: `${id}-ports`,
					remoteId,
					domains,
				}));
			}

			return {
				remoteId,
				async writeFile(path, content) {
					await sandbox.writeFiles([{ path, content: Buffer.from(content) }]);
				},
				async readFile(path) {
					return decodeVercelFile(await sandbox.readFile({ path }));
				},
				async exec(command, opts) {
					if (opts.signal?.aborted) {
						throw new Error("Vercel sandbox command aborted before it started.");
					}
					/** @type {Record<string, unknown>} */
					const runInput = {
						cmd: "sh",
						args: ["-c", command],
						cwd: opts.cwd,
						env: opts.env,
					};
					// Forward a per-command timeout to the SDK when one is set. The SDK
					// ignores fields it does not recognize; we also race a local timeout
					// below so the deadline is enforced regardless.
					if (Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) {
						runInput.timeout = opts.timeoutMs;
					}
					const done = await raceCommand(sandbox.runCommand(runInput), opts.signal, opts.timeoutMs);
					return {
						exitCode: done.exitCode ?? 0,
						stdout: String(await done.stdout()),
						stderr: String(await done.stderr()),
					};
				},
				async destroy() {
					if (persist) {
						if (typeof sandbox.stop === "function") await sandbox.stop();
						return;
					}
					if (typeof sandbox.delete === "function") {
						await sandbox.delete();
						return;
					}
					if (typeof sandbox.stop === "function") await sandbox.stop();
				},
			};
		},
	});
}

/**
 * Race a running command against its abort signal and an optional per-command
 * timeout so `exec` rejects promptly instead of waiting for the command to
 * finish. The abort listener and timer are always torn down on settle so
 * neither leaks when the command wins the race.
 *
 * @template T
 * @param {Promise<T>} commandPromise
 * @param {AbortSignal | undefined} signal
 * @param {number | undefined} timeoutMs
 * @returns {Promise<T>}
 */
function raceCommand(commandPromise, signal, timeoutMs) {
	const hasTimeout = Number.isFinite(timeoutMs) && /** @type {number} */ (timeoutMs) > 0;
	if (!signal && !hasTimeout) {
		return commandPromise;
	}
	/** @type {(() => void) | undefined} */
	let onAbort;
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let timer;
	const guard = /** @type {Promise<never>} */ (
		new Promise((_resolve, reject) => {
			if (signal) {
				onAbort = () => reject(new Error("Vercel sandbox command aborted."));
				signal.addEventListener("abort", onAbort, { once: true });
			}
			if (hasTimeout) {
				timer = setTimeout(
					() => reject(new Error(`Vercel sandbox command timed out after ${timeoutMs}ms.`)),
					/** @type {number} */ (timeoutMs),
				);
			}
		})
	);
	return Promise.race([commandPromise, guard]).finally(() => {
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		if (timer) clearTimeout(timer);
	});
}

/**
 * Build the auth object handed to `Sandbox.create`. OIDC is preferred; falls
 * back to the access-token trio. Throws INVALID_INPUT when neither is available.
 *
 * @param {import("./VercelSandboxProviderOptions.ts").VercelSandboxProviderOptions} options
 * @param {string} provider
 * @returns {{ oidcToken: string } | { token: string; teamId: string; projectId: string }}
 */
function resolveVercelAuth(options, provider) {
	const oidcToken = options.oidcToken ?? process.env.VERCEL_OIDC_TOKEN;
	if (oidcToken) {
		return { oidcToken };
	}
	const token = options.token ?? process.env.VERCEL_TOKEN;
	const teamId = options.teamId ?? process.env.VERCEL_TEAM_ID;
	const projectId = options.projectId ?? process.env.VERCEL_PROJECT_ID;
	if (token && teamId && projectId) {
		return { token, teamId, projectId };
	}
	throw new SmithersError(
		"INVALID_INPUT",
		"Vercel sandbox provider requires authentication: set VERCEL_OIDC_TOKEN (preferred), or VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID (or pass them via options).",
		{ provider },
	);
}

/**
 * @param {import("./VercelSandboxProviderOptions.ts").VercelSandboxProviderOptions} options
 * @param {Record<string, string>} auth
 * @returns {string[]}
 */
function collectSecrets(options, auth) {
	const out = [];
	for (const value of Object.values(auth)) {
		if (typeof value === "string" && value.length > 0) out.push(value);
	}
	for (const [key, value] of Object.entries(options.env ?? {})) {
		if (SECRET_KEY_RE.test(key) && typeof value === "string" && value.length > 0) out.push(value);
	}
	return out;
}

/**
 * @param {string} message
 * @param {string[]} secrets
 * @returns {string}
 */
function scrubSecrets(message, secrets) {
	let out = message;
	for (const secret of secrets) {
		out = out.split(secret).join("[redacted]");
	}
	return out;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Lazily import the optional `@vercel/sandbox` SDK, with an actionable error.
 *
 * @param {string} provider
 * @returns {Promise<import("./VercelSandboxProviderOptions.ts").VercelSandboxClient>}
 */
async function loadVercelSandbox(provider) {
	let mod;
	try {
		mod = await import("@vercel/sandbox");
	} catch (error) {
		throw new SmithersError(
			"INVALID_INPUT",
			`Vercel sandbox provider needs the optional "@vercel/sandbox" package. Install it with: npm install @vercel/sandbox. (${messageOf(error)})`,
			{ provider },
		);
	}
	const Sandbox = mod?.Sandbox ?? mod?.default?.Sandbox;
	if (!Sandbox || typeof Sandbox.create !== "function") {
		throw new SmithersError("INVALID_INPUT", "@vercel/sandbox does not export a Sandbox class with a static create().", { provider });
	}
	return Sandbox;
}

/**
 * Decode whatever `sandbox.readFile` returns into a string (string, Buffer/
 * Uint8Array, ReadableStream, or an object exposing text()/content).
 *
 * @param {unknown} value
 * @returns {Promise<string>}
 */
async function decodeVercelFile(value) {
	if (value == null) return "";
	if (typeof value === "string") return value;
	if (value instanceof Uint8Array) return new TextDecoder().decode(value);
	if (typeof value === "object") {
		const obj = /** @type {{ text?: unknown; content?: unknown }} */ (value);
		if (typeof obj.text === "function") {
			return String(await /** @type {() => Promise<string> | string} */ (obj.text)());
		}
		if (obj.content instanceof Uint8Array) return new TextDecoder().decode(obj.content);
		if (typeof obj.content === "string") return obj.content;
		if (value instanceof ReadableStream) {
			return await readStreamToString(value);
		}
	}
	return String(value);
}

/**
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {Promise<string>}
 */
async function readStreamToString(stream) {
	const chunks = [];
	const reader = stream.getReader();
	while (true) {
		const next = await reader.read();
		if (next.done) break;
		chunks.push(next.value);
	}
	return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

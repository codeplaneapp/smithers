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
			// Resolve auth BEFORE touching the SDK. Any explicit credential is
			// mapped into the SDK's real `{ token, teamId?, projectId? }` shape;
			// when none is given we hand the SDK an empty object so it can
			// self-discover credentials from the environment (VERCEL_OIDC_TOKEN).
			const auth = resolveVercelAuth(options);
			const secrets = collectSecrets(options, auth);
			const Sandbox = options.client ?? (await loadVercelSandbox(id, options.importSdk));

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

			// 1.x exposes the id as `.sandboxId`; 2.x renamed it to `.name`. Prefer
			// whichever the running SDK provides, falling back to a synthetic id.
			const remoteId =
				(typeof sandbox.sandboxId === "string" && sandbox.sandboxId.length > 0 && sandbox.sandboxId) ||
				(typeof sandbox.name === "string" && sandbox.name.length > 0 && sandbox.name) ||
				`${request.runId}-${request.sandboxId}`;

				try {
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
							// extendTimeout extends the lifetime BY its argument, so send the
							// remaining delta; passing the absolute target would overshoot the
							// cap by createTimeoutMs.
							await sandbox.extendTimeout(desiredMs - createTimeoutMs);
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
				} catch (error) {
					await destroyVercelSandbox(sandbox, false).catch((cleanupError) => {
						request.heartbeat(redactSandboxProviderValue({
							sandboxId: request.sandboxId,
							stage: `${id}-cleanup-failed`,
							level: "warn",
							remoteId,
							error: scrubSecrets(messageOf(cleanupError), secrets),
						}));
					});
					throw new SmithersError(
						"SANDBOX_EXECUTION_FAILED",
						`Vercel sandbox setup failed: ${scrubSecrets(messageOf(error), secrets)}`,
						{ provider: id, remoteId },
					);
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
						signal: opts.signal,
					};
					// Forward a per-command timeout to the SDK when one is set. We also
					// race a local timeout below so the deadline is enforced promptly.
					if (Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) {
						runInput.timeoutMs = opts.timeoutMs;
					}
					const done = await raceCommand(sandbox.runCommand(runInput), opts.signal, opts.timeoutMs);
					return {
						exitCode: done.exitCode ?? 0,
						stdout: String(await done.stdout()),
						stderr: String(await done.stderr()),
					};
					},
					async destroy() {
						await destroyVercelSandbox(sandbox, persist);
					},
				};
			},
		});
	}

async function destroyVercelSandbox(sandbox, persist) {
	if (persist) {
		if (typeof sandbox.stop === "function") await sandbox.stop();
		return;
	}
	if (typeof sandbox.delete === "function") {
		await sandbox.delete();
		return;
	}
	if (typeof sandbox.stop === "function") await sandbox.stop();
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
 * Build the auth object handed to `Sandbox.create`.
 *
 * The real `@vercel/sandbox` SDK takes `{ token, teamId?, projectId? }` — there
 * is NO `oidcToken` create param. The `token` field "could be an OIDC token or a
 * personal access token" (per the SDK doc), so an explicit OIDC token maps
 * straight into `token`. An access-token trio maps to `{ token, teamId,
 * projectId }`. When neither explicit credential is configured we return an
 * empty object and let the SDK self-discover credentials from the environment
 * (e.g. `VERCEL_OIDC_TOKEN` in `process.env`) rather than throwing.
 *
 * @param {import("./VercelSandboxProviderOptions.ts").VercelSandboxProviderOptions} options
 * @returns {{ token: string } | { token: string; teamId: string; projectId: string } | {}}
 */
function resolveVercelAuth(options) {
	const oidcToken = options.oidcToken ?? process.env.VERCEL_OIDC_TOKEN;
	if (oidcToken) {
		return { token: oidcToken };
	}
	const token = options.token ?? process.env.VERCEL_TOKEN;
	const teamId = options.teamId ?? process.env.VERCEL_TEAM_ID;
	const projectId = options.projectId ?? process.env.VERCEL_PROJECT_ID;
	if (token && teamId && projectId) {
		return { token, teamId, projectId };
	}
	// No explicit credentials: defer to the SDK's environment self-discovery.
	return {};
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
 * `importSdk` is an optional injectable importer used only by tests to exercise
 * the not-installed / bad-export paths deterministically; production defaults to
 * the real dynamic import.
 *
 * @param {string} provider
 * @param {(() => Promise<unknown>) | undefined} [importSdk]
 * @returns {Promise<import("./VercelSandboxProviderOptions.ts").VercelSandboxClient>}
 */
async function loadVercelSandbox(provider, importSdk) {
	let mod;
	try {
		mod = await (importSdk ? importSdk() : import("@vercel/sandbox"));
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
 * Decode whatever `sandbox.readFile` returns into a string.
 *
 * The real `@vercel/sandbox` `readFile({ path })` resolves a Node
 * `ReadableStream` (or `null`). Both a Node `Readable` and a web `ReadableStream`
 * are async-iterable over their chunks, so a single `for await` covers both. The
 * string / Uint8Array fast-paths and the `text()`/`content` object shapes are
 * kept for test doubles and older SDK surfaces.
 *
 * @param {unknown} value
 * @returns {Promise<string>}
 */
async function decodeVercelFile(value) {
	if (value == null) return "";
	if (typeof value === "string") return value;
	if (value instanceof Uint8Array) return new TextDecoder().decode(value);
	if (typeof value === "object") {
		const obj = /** @type {{ text?: unknown; content?: unknown; [Symbol.asyncIterator]?: unknown }} */ (value);
		if (typeof obj[Symbol.asyncIterator] === "function") {
			return await readAsyncIterableToString(/** @type {AsyncIterable<unknown>} */ (value));
		}
		if (typeof obj.text === "function") {
			return String(await /** @type {() => Promise<string> | string} */ (obj.text)());
		}
		if (obj.content instanceof Uint8Array) return new TextDecoder().decode(obj.content);
		if (typeof obj.content === "string") return obj.content;
	}
	return String(value);
}

/**
 * Concatenate an async-iterable of chunks (Node `Readable` yields `Buffer`s, web
 * `ReadableStream` yields `Uint8Array`s; strings are accepted too) into a string.
 *
 * @param {AsyncIterable<unknown>} iterable
 * @returns {Promise<string>}
 */
async function readAsyncIterableToString(iterable) {
	const decoder = new TextDecoder();
	let out = "";
	for await (const chunk of iterable) {
		if (typeof chunk === "string") out += chunk;
		else if (chunk instanceof Uint8Array) out += decoder.decode(chunk, { stream: true });
		else if (chunk != null) out += decoder.decode(new Uint8Array(Buffer.from(String(chunk))), { stream: true });
	}
	out += decoder.decode();
	return out;
}

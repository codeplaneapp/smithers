import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { normalizeSandboxEgressConfig, sandboxEgressEnv } from "../egress.js";
import { SANDBOX_PROVIDER_REQUEST_ENV } from "./SANDBOX_PROVIDER_REQUEST_ENV.js";
import { SANDBOX_PROVIDER_RESULT_ENV } from "./SANDBOX_PROVIDER_RESULT_ENV.js";
import { parseSandboxProviderResult } from "./parseSandboxProviderResult.js";
import { uploadEgressCaToSession } from "./uploadEgressCaToSession.js";
import { writeSandboxProviderRequestFile } from "./writeSandboxProviderRequestFile.js";

const DEFAULT_COMMAND = "node /workspace/run-smithers-sandbox.js";
const DEFAULT_WORKDIR = "/workspace";
const DEFAULT_REQUEST_FILE = ".smithers/sandbox-request.json";
const DEFAULT_RESULT_FILE = ".smithers/sandbox-result.json";
const SECRET_KEY_RE = /token|secret|key|password|credential|authorization|passwd|apikey/i;

/**
 * Build a SandboxProvider that runs a command inside a remote session managed
 * through the small SandboxSession seam. Vendor providers supply a createSession
 * factory; the kit handles request shipping, egress, result parsing, secret
 * scrubbing, and cleanup uniformly.
 *
 * @param {import("./SandboxProviderCommandOptions.ts").SandboxProviderCommandOptions} options
 * @returns {import("../SandboxProvider.ts").SandboxProvider}
 */
export function createCommandSandboxProvider(options) {
	const id = typeof options?.id === "string" ? options.id.trim() : "";
	if (!id) {
		throw new SmithersError("INVALID_INPUT", "Command sandbox provider requires a non-empty id.");
	}
	if (typeof options.createSession !== "function") {
		throw new SmithersError("INVALID_INPUT", "Command sandbox provider requires a createSession function.", { provider: id });
	}
	const command = (options.command ?? DEFAULT_COMMAND).trim();
	if (!command) {
		throw new SmithersError("INVALID_INPUT", "Command sandbox provider command must not be empty.", { provider: id });
	}
	const cleanupMode = options.cleanup ?? "destroy";
	if (cleanupMode !== "destroy" && cleanupMode !== "keep") {
		throw new SmithersError("INVALID_INPUT", "Command sandbox provider cleanup must be \"destroy\" or \"keep\".", { provider: id, cleanup: cleanupMode });
	}
	const workdir = options.workdir ?? DEFAULT_WORKDIR;
	const requestFile = options.requestFile ?? DEFAULT_REQUEST_FILE;
	const resultFile = options.resultFile ?? DEFAULT_RESULT_FILE;
	/** @type {Map<string, import("./SandboxSession.ts").SandboxSession>} */
	const active = new Map();

	return {
		id,
		async run(request) {
			const egressEnv = sandboxEgressEnv(request.egress);
			const secrets = collectSecretValues(options.env, request.egress, egressEnv);
			const session = await options.createSession(request);
			const key = `${request.runId}:${request.sandboxId}`;
			active.set(key, session);
			request.heartbeat({ sandboxId: request.sandboxId, stage: `${id}-session-created`, remoteId: session.remoteId });

			const requestPath = absolutePath(workdir, requestFile);
			const resultPath = absolutePath(workdir, resultFile);
			await writeSandboxProviderRequestFile(session, requestPath, request);
			await uploadEgressCaToSession(session, request.egress, workdir);
			request.heartbeat({ sandboxId: request.sandboxId, stage: `${id}-request-shipped`, remoteId: session.remoteId });

			const env = {
				...(options.env ?? {}),
				...egressEnv,
				[SANDBOX_PROVIDER_REQUEST_ENV]: requestPath,
				[SANDBOX_PROVIDER_RESULT_ENV]: resultPath,
			};

			let res;
			try {
				res = await session.exec(command, {
					cwd: workdir,
					env,
					timeoutMs: request.toolTimeoutMs,
					signal: request.signal,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new SmithersError("SANDBOX_EXECUTION_FAILED", scrubSecrets(message, secrets), { provider: id, remoteId: session.remoteId });
			}

			const stdout = String(res?.stdout ?? "").trim();
			const exitCode = Number(res?.exitCode ?? 0);
			const stdoutIsJson = stdout.startsWith("{");
			if (exitCode !== 0 && !stdoutIsJson) {
				const detail = scrubSecrets(truncateOutput(String(res?.stderr ?? "") || stdout, request.maxOutputBytes), secrets);
				throw new SmithersError(
					"SANDBOX_EXECUTION_FAILED",
					`Sandbox command "${command}" exited with code ${exitCode}: ${detail}`,
					{ provider: id, remoteId: session.remoteId, exitCode },
				);
			}

			const raw = stdoutIsJson ? stdout : await session.readFile(resultPath);
			request.heartbeat({ sandboxId: request.sandboxId, stage: `${id}-result-read`, remoteId: session.remoteId });
			return parseSandboxProviderResult(raw, session.remoteId, { provider: id, resultPath });
		},
		async cleanup(request) {
			const key = `${request.runId}:${request.sandboxId}`;
			const session = active.get(key);
			active.delete(key);
			if (!session || cleanupMode !== "destroy") {
				return;
			}
			if (typeof session.destroy === "function") {
				await session.destroy();
			}
		},
	};
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
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
function truncateOutput(text, maxBytes) {
	if (!Number.isFinite(maxBytes) || maxBytes <= 0 || text.length <= maxBytes) {
		return text;
	}
	const kept = text.slice(0, maxBytes);
	return `${kept}… [truncated ${text.length - maxBytes} chars]`;
}

/**
 * Collect every value that must be scrubbed from thrown exec-error messages:
 * secret-keyed values from the provider's static env, every egress-injected env
 * value, and the HTTP(S)_PROXY URLs (which may embed user:pass@ credentials).
 *
 * @param {Record<string, string> | undefined} optionsEnv
 * @param {unknown} egress
 * @param {Record<string, string>} egressEnv
 * @returns {string[]}
 */
function collectSecretValues(optionsEnv, egress, egressEnv) {
	const out = secretValuesFrom(optionsEnv);
	const normalized = normalizeSandboxEgressConfig(egress);
	for (const value of Object.values(normalized?.env ?? {})) {
		if (typeof value === "string" && value.length > 0) {
			out.push(value);
		}
	}
	for (const key of ["HTTP_PROXY", "HTTPS_PROXY"]) {
		const value = egressEnv[key];
		if (typeof value === "string" && value.length > 0) {
			out.push(value);
		}
	}
	return out;
}

/**
 * @param {Record<string, string> | undefined} env
 * @returns {string[]}
 */
function secretValuesFrom(env) {
	if (!env) {
		return [];
	}
	const out = [];
	for (const [key, value] of Object.entries(env)) {
		if (SECRET_KEY_RE.test(key) && typeof value === "string" && value.length > 0) {
			out.push(value);
		}
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

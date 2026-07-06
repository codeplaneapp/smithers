import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { GCP_SANDBOX_PROVIDER_ID } from "./GCP_SANDBOX_PROVIDER_ID.js";

/**
 * @param {import("./GcpSandboxProviderOptions.ts").GcpRunJobsClient} jobsClient
 * @param {string} projectId
 * @param {string} location
 * @param {string} jobName
 * @returns {string}
 */
function jobResourceName(jobsClient, projectId, location, jobName) {
	if (typeof jobsClient.jobPath === "function") {
		return jobsClient.jobPath(projectId, location, jobName);
	}
	return `projects/${projectId}/locations/${location}/jobs/${jobName}`;
}

/**
 * @param {Record<string, string>} env
 * @returns {Array<{ name: string; value: string }>}
 */
function toEnvList(env) {
	return Object.entries(env).map(([name, value]) => ({ name, value: String(value) }));
}

/**
 * Derive a POSIX exit code from a Cloud Run v2 Execution. Cloud Run reports task
 * counts and conditions, not a numeric container exit code: a succeeded task is
 * exit 0, any failed task is exit 1.
 *
 * @param {import("./GcpSandboxProviderOptions.ts").GcpCloudRunExecution} execution
 * @returns {{ exitCode: number; stderr: string }}
 */
function executionOutcome(execution) {
	const succeeded = Number(execution?.succeededCount ?? 0);
	const failed = Number(execution?.failedCount ?? 0);
	const conditions = Array.isArray(execution?.conditions) ? execution.conditions : [];
	if (succeeded >= 1) {
		return { exitCode: 0, stderr: "" };
	}
	if (failed > 0) {
		return { exitCode: 1, stderr: conditionMessage(conditions) };
	}
	const completed = conditions.find((condition) => condition?.type === "Completed");
	if (completed && completed.state && completed.state !== "CONDITION_SUCCEEDED") {
		return { exitCode: 1, stderr: conditionMessage(conditions) };
	}
	return { exitCode: 0, stderr: "" };
}

/**
 * @param {Array<{ type?: string; state?: string; message?: string }>} conditions
 * @returns {string}
 */
function conditionMessage(conditions) {
	return conditions
		.filter((condition) => typeof condition?.message === "string" && condition.message.length > 0)
		.map((condition) => condition.message)
		.join("; ");
}

/**
 * Build the Cloud Run Jobs runner a GCP sandbox session uses to execute the
 * in-container entry command. It optionally creates a per-run job (LRO), then
 * `runJob` with container overrides that carry the command + env, awaits the
 * execution LRO, and maps the execution outcome to `{ exitCode, stdout, stderr }`.
 * The container round-trips its result bundle through Cloud Storage, so stdout
 * is always empty here — the kit reads the result object via the transport.
 *
 * @param {{
 *   jobsClient: import("./GcpSandboxProviderOptions.ts").GcpRunJobsClient;
 *   projectId: string;
 *   location: string;
 *   jobName: string;
 *   createJob?: boolean;
 *   timeoutSec?: number;
 *   provider?: string;
 * }} options
 */
export function createGcpCloudRunJobsSandboxRunner(options) {
	const { jobsClient, projectId, location, jobName } = options;
	const provider = options.provider ?? GCP_SANDBOX_PROVIDER_ID;
	const name = jobResourceName(jobsClient, projectId, location, jobName);
	let createdJob = false;
	let ensured = false;
	/** @type {string | undefined} */
	let lastExecutionName;

	async function ensureJob() {
		if (ensured) return;
		ensured = true;
		if (!options.createJob) return;
		if (typeof jobsClient.createJob !== "function") {
			throw new SmithersError(
				"INVALID_INPUT",
				"GCP sandbox provider createJob requires a JobsClient with createJob().",
				{ provider },
			);
		}
		const parent = typeof jobsClient.locationPath === "function"
			? jobsClient.locationPath(projectId, location)
			: `projects/${projectId}/locations/${location}`;
		const [operation] = await jobsClient.createJob({ parent, jobId: jobName, job: {} });
		await operation.promise();
		createdJob = true;
	}

	return {
		get remoteId() {
			return lastExecutionName ?? name;
		},
		get createdJob() {
			return createdJob;
		},
		/**
		 * @param {{ command: string; env: Record<string, string>; timeoutMs?: number; signal?: AbortSignal }} exec
		 * @returns {Promise<{ exitCode: number; stdout: string; stderr: string }>}
		 */
		async run(exec) {
			if (exec.signal?.aborted) {
				throw new SmithersError("SANDBOX_EXECUTION_FAILED", "GCP sandbox execution was cancelled before start.", { provider });
			}
			await ensureJob();
			const timeoutSec = options.timeoutSec
				?? (Number.isFinite(exec.timeoutMs) && exec.timeoutMs && exec.timeoutMs > 0
					? Math.ceil(exec.timeoutMs / 1000)
					: undefined);
			const [operation] = await jobsClient.runJob({
				name,
				overrides: {
					containerOverrides: [
						{
							env: toEnvList(exec.env),
							args: ["sh", "-c", exec.command],
						},
					],
					...(timeoutSec ? { timeout: { seconds: timeoutSec } } : {}),
				},
			});

			// Cloud Run's runJob LRO carries the Execution being created in its
			// metadata. Capture it now so a mid-flight abort cancels the actual
			// execution resource rather than the job resource (`name`).
			const metadataName = operation && typeof operation === "object"
				? /** @type {{ metadata?: { name?: unknown } }} */ (operation).metadata?.name
				: undefined;
			const pendingExecutionName = typeof metadataName === "string" ? metadataName : undefined;

			// Best-effort cancellation of an in-flight execution. Cancel the LRO
			// first (if the operation supports it), then ask the client to
			// cancel/delete the Cloud Run execution if it exposes that path.
			// Errors are swallowed: the run is already being torn down.
			const cancelExecution = async () => {
				try {
					if (typeof operation.cancel === "function") await operation.cancel();
				} catch {
					// operation may already be settled; ignore.
				}
				const target = lastExecutionName ?? name;
				try {
					if (typeof jobsClient.cancelExecution === "function") {
						const [op] = await jobsClient.cancelExecution({ name: target });
						await op?.promise?.();
					} else if (typeof jobsClient.deleteExecution === "function") {
						const [op] = await jobsClient.deleteExecution({ name: target });
						await op?.promise?.();
					}
				} catch {
					// execution may already be gone; cancellation is best-effort.
				}
			};

			// Race the execution LRO against the abort signal. Without this the
			// run would block on operation.promise() until Cloud Run finished
			// even after an abort, never cancelling the execution.
			const signal = exec.signal;
			/** @type {(() => void) | undefined} */
			let removeAbortListener;
			const execution = await new Promise((resolve, reject) => {
				operation.promise().then(
					([value]) => resolve(value),
					(error) => reject(error),
				);
				if (signal) {
					const onAbort = () => {
						void cancelExecution();
						reject(new SmithersError("SANDBOX_EXECUTION_FAILED", "GCP sandbox execution was cancelled.", { provider }));
					};
					signal.addEventListener("abort", onAbort, { once: true });
					removeAbortListener = () => signal.removeEventListener("abort", onAbort);
				}
			}).finally(() => {
				removeAbortListener?.();
			});

			lastExecutionName = execution?.name ?? lastExecutionName ?? name;
			const outcome = executionOutcome(execution);
			return { exitCode: outcome.exitCode, stdout: "", stderr: outcome.stderr };
		},
		/**
		 * Delete the per-run job when this runner created it. No-op for reused jobs.
		 * @returns {Promise<void>}
		 */
		async deleteJob() {
			if (!createdJob || typeof jobsClient.deleteJob !== "function") return;
			try {
				const [operation] = await jobsClient.deleteJob({ name });
				await operation.promise();
			} catch {
				// job may already be gone; deletion is best-effort.
			}
		},
	};
}

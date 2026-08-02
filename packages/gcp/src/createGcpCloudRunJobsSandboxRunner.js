import { SmithersError } from "@smthrs/errors/SmithersError";
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
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown[]} values
 * @returns {string | undefined}
 */
function pickString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function plainObject(value) {
  return isPlainObject(value) ? value : {};
}

/**
 * Build the Cloud Run v2 Job payload needed by createJob. The public provider
 * types intentionally stay narrow, but advanced callers may pass a partial
 * `job`/`template`/`executionTemplate`/`container` object through this runner.
 *
 * @param {Record<string, unknown>} options
 * @param {number | undefined} timeoutSec
 * @param {string} provider
 * @returns {Record<string, unknown>}
 */
function buildCreateJobBody(options, timeoutSec, provider) {
  const sourceJob = plainObject(options.job);
  const job = { ...sourceJob };
  delete job.executionTemplate;

  const executionTemplate = {
    ...plainObject(sourceJob.template),
    ...plainObject(sourceJob.executionTemplate),
    ...plainObject(options.template),
    ...plainObject(options.executionTemplate),
  };
  const taskTemplate = {
    ...plainObject(executionTemplate.template),
    ...plainObject(options.taskTemplate),
  };
  const existingContainers = Array.isArray(taskTemplate.containers)
    ? taskTemplate.containers.filter(isPlainObject).map((container) => ({ ...container }))
    : [];
  const container = {
    ...existingContainers[0],
    ...plainObject(options.container),
  };
  const image = pickString(options.image, options.containerImage, container.image);
  if (!image) {
    throw new SmithersError(
      "INVALID_INPUT",
      "GCP sandbox provider createJob requires a container image in runner options (`image`) or a Cloud Run job template.",
      { provider },
    );
  }

  container.image = image;
  const workingDir = pickString(options.workingDir, options.workdir, container.workingDir);
  if (workingDir) container.workingDir = workingDir;
  if (!Array.isArray(container.env) && isPlainObject(options.env)) {
    container.env = toEnvList(/** @type {Record<string, string>} */ (options.env));
  }
  if (timeoutSec && !isPlainObject(taskTemplate.timeout)) {
    taskTemplate.timeout = { seconds: timeoutSec };
  }

  taskTemplate.containers = [container, ...existingContainers.slice(1)];
  executionTemplate.template = taskTemplate;
  job.template = executionTemplate;
  return job;
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
 *   image?: string;
 *   containerImage?: string;
 *   workdir?: string;
 *   workingDir?: string;
 *   env?: Record<string, string>;
 *   job?: Record<string, unknown>;
 *   template?: Record<string, unknown>;
 *   executionTemplate?: Record<string, unknown>;
 *   taskTemplate?: Record<string, unknown>;
 *   container?: Record<string, unknown>;
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

  /**
   * @param {number | undefined} timeoutSec
   */
  async function ensureJob(timeoutSec) {
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
    const parent =
      typeof jobsClient.locationPath === "function"
        ? jobsClient.locationPath(projectId, location)
        : `projects/${projectId}/locations/${location}`;
    const job = buildCreateJobBody(options, timeoutSec, provider);
    const [operation] = await jobsClient.createJob({ parent, jobId: jobName, job });
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
        throw new SmithersError("SANDBOX_EXECUTION_FAILED", "GCP sandbox execution was cancelled before start.", {
          provider,
        });
      }
      const timeoutSec =
        options.timeoutSec ??
        (Number.isFinite(exec.timeoutMs) && exec.timeoutMs && exec.timeoutMs > 0
          ? Math.ceil(exec.timeoutMs / 1000)
          : undefined);
      await ensureJob(timeoutSec);
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
      const metadataName =
        operation && typeof operation === "object"
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
        // Only cancel/delete when we know the execution resource. `name` is
        // the job resource, which cancelExecution/deleteExecution would
        // reject, so skip the execution call and rely on the LRO cancel.
        const target = lastExecutionName ?? pendingExecutionName;
        if (typeof target !== "string") return;
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
          // The abort can land while ensureJob()/runJob() are still in
          // flight, before any listener exists. A listener added to an
          // already-aborted signal never fires, so re-check here.
          if (signal.aborted) onAbort();
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

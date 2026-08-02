import { SmithersError } from "@smthrs/errors/SmithersError";
import { AWS_SANDBOX_PROVIDER_ID } from "./AWS_SANDBOX_PROVIDER_ID.js";
import { readCloudWatchLogs } from "./readCloudWatchLogs.js";
import { resolveAwsSdkClient } from "./resolveAwsSdkClient.js";
import { scrubAwsSandboxSecrets } from "./scrubAwsSandboxSecrets.js";

const POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * @param {Record<string, string>} env
 * @returns {Array<{ name: string; value: string; type: string }>}
 */
function toCodeBuildEnvironment(env) {
  return Object.entries(env).map(([name, value]) => ({ name, value: String(value), type: "PLAINTEXT" }));
}

/**
 * @param {string} command
 * @returns {string}
 */
function buildspecFor(command) {
  // The command already carries the SMITHERS_SANDBOX_* env vars; CodeBuild runs
  // it verbatim so the container entry can round-trip through S3.
  return `version: 0.2\nphases:\n  build:\n    commands:\n      - ${JSON.stringify(command)}\n`;
}

/**
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    /** @type {ReturnType<typeof setTimeout>} */
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    };
    timer = setTimeout(() => {
      // Detach the abort listener on the normal path too: a long poll would
      // otherwise accrue one listener per 500ms tick on a shared signal
      // (MaxListenersExceededWarning + unbounded growth).
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener("abort", onAbort);
  });
}

/**
 * Build the CodeBuild remote runner. It starts one build per exec with an S3
 * source/artifacts override and a generated buildspec that runs the command,
 * then polls BatchGetBuilds. CodeBuild reports a status, not a numeric exit, so
 * `SUCCEEDED` maps to exit 0 and anything else to exit 1.
 *
 * @param {{
 *   client?: unknown;
 *   clientOptions?: Record<string, unknown>;
 *   projectName?: string;
 *   bucket?: string;
 *   prefix?: string;
 *   captureLogs?: boolean;
 *   logs?: unknown;
 *   maxOutputBytes?: number;
 *   secrets?: string[];
 * }} options
 */
export async function createAwsCodeBuildSandboxRunner(options) {
  const projectName = typeof options.projectName === "string" ? options.projectName.trim() : "";
  if (!projectName)
    throw new SmithersError("INVALID_INPUT", "AWS codebuild sandbox requires a `projectName`.", {
      provider: AWS_SANDBOX_PROVIDER_ID,
    });

  const codebuild = await resolveAwsSdkClient({
    injected: options.client,
    moduleName: "@aws-sdk/client-codebuild",
    clientExport: "CodeBuildClient",
    methods: ["startBuild", "batchGetBuilds", "stopBuild"],
    clientOptions: options.clientOptions,
  });
  const secrets = options.secrets ?? [];
  const bucket = options.bucket ?? "";
  const prefix = options.prefix ?? "";

  /** @type {string | undefined} */
  let buildId;
  let stopped = false;

  /**
   * @param {AbortSignal} [signal]
   */
  async function stop(signal) {
    if (!buildId || stopped) return;
    stopped = true;
    try {
      await codebuild.stopBuild({ id: buildId }, { abortSignal: signal });
    } catch {
      // best-effort
    }
  }

  /**
   * @param {string} idToPoll
   * @param {{ timeoutMs: number; signal?: AbortSignal }} pollOpts
   * @returns {Promise<Record<string, any>>}
   */
  async function pollUntilComplete(idToPoll, pollOpts) {
    const timeoutMs =
      Number.isFinite(pollOpts.timeoutMs) && pollOpts.timeoutMs > 0 ? pollOpts.timeoutMs : DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (pollOpts.signal?.aborted) {
        await stop();
        throw new SmithersError("SANDBOX_EXECUTION_FAILED", "AWS codebuild sandbox build was cancelled.", {
          provider: AWS_SANDBOX_PROVIDER_ID,
          remoteId: idToPoll,
        });
      }
      const res = await codebuild.batchGetBuilds({ ids: [idToPoll] }, { abortSignal: pollOpts.signal });
      const build = /** @type {{ builds?: Array<Record<string, any>> }} */ (res)?.builds?.[0];
      if (build && String(build.buildStatus) !== "IN_PROGRESS") {
        // The build has already terminated, so cleanup must not issue a redundant StopBuild.
        stopped = true;
        return build;
      }
      if (Date.now() >= deadline) {
        await stop(pollOpts.signal);
        throw new SmithersError(
          "SANDBOX_EXECUTION_FAILED",
          `AWS codebuild sandbox build did not finish within ${timeoutMs}ms.`,
          { provider: AWS_SANDBOX_PROVIDER_ID, remoteId: idToPoll },
        );
      }
      try {
        await sleep(POLL_INTERVAL_MS, pollOpts.signal);
      } catch {
        await stop();
        throw new SmithersError("SANDBOX_EXECUTION_FAILED", "AWS codebuild sandbox build was cancelled.", {
          provider: AWS_SANDBOX_PROVIDER_ID,
          remoteId: idToPoll,
        });
      }
    }
  }

  return {
    get remoteId() {
      return buildId;
    },
    /**
     * @param {string} command
     * @param {{ env: Record<string, string>; timeoutMs: number; signal?: AbortSignal }} execOpts
     * @returns {Promise<{ exitCode: number; stdout: string; stderr: string }>}
     */
    async run(command, execOpts) {
      if (execOpts.signal?.aborted) {
        throw new SmithersError(
          "SANDBOX_EXECUTION_FAILED",
          "AWS codebuild sandbox build was cancelled before launch.",
          { provider: AWS_SANDBOX_PROVIDER_ID },
        );
      }
      // CodeBuild's `timeoutInMinutesOverride` must be 5..2160; a sub-5-minute
      // toolTimeoutMs would otherwise send 1 and StartBuild rejects. Clamp to the
      // AWS-legal range — the local poll deadline still enforces the shorter real
      // timeout via `pollUntilComplete`.
      const timeoutMinutes =
        Number.isFinite(execOpts.timeoutMs) && execOpts.timeoutMs > 0
          ? Math.min(2160, Math.max(5, Math.ceil(execOpts.timeoutMs / 60_000)))
          : undefined;
      const startInput = {
        projectName,
        sourceTypeOverride: "S3",
        sourceLocationOverride: `${bucket}/${prefix}/`,
        artifactsOverride: { type: "S3", location: bucket, path: prefix, namespaceType: "NONE", packaging: "NONE" },
        buildspecOverride: buildspecFor(command),
        environmentVariablesOverride: toCodeBuildEnvironment(execOpts.env),
        ...(timeoutMinutes ? { timeoutInMinutesOverride: timeoutMinutes } : {}),
      };
      let startRes;
      try {
        startRes = await codebuild.startBuild(startInput, { abortSignal: execOpts.signal });
      } catch (error) {
        if (execOpts.signal?.aborted) {
          throw new SmithersError(
            "SANDBOX_EXECUTION_FAILED",
            "AWS codebuild sandbox build was cancelled before launch.",
            { provider: AWS_SANDBOX_PROVIDER_ID },
          );
        }
        const detail = scrubAwsSandboxSecrets(error instanceof Error ? error.message : String(error), secrets);
        throw new SmithersError("SANDBOX_EXECUTION_FAILED", `AWS codebuild StartBuild failed: ${detail}`, {
          provider: AWS_SANDBOX_PROVIDER_ID,
        });
      }
      buildId = /** @type {{ build?: { id?: string } }} */ (startRes)?.build?.id;
      if (!buildId) {
        throw new SmithersError("SANDBOX_EXECUTION_FAILED", "AWS codebuild StartBuild returned no build id.", {
          provider: AWS_SANDBOX_PROVIDER_ID,
        });
      }

      let build;
      try {
        build = await pollUntilComplete(buildId, { timeoutMs: execOpts.timeoutMs, signal: execOpts.signal });
      } catch (error) {
        // A remote build now exists. Attempt cleanup exactly once, but do not pass
        // an already-aborted signal because the cleanup request must still run.
        await stop();
        if (execOpts.signal?.aborted) {
          throw new SmithersError("SANDBOX_EXECUTION_FAILED", "AWS codebuild sandbox build was cancelled.", {
            provider: AWS_SANDBOX_PROVIDER_ID,
            remoteId: buildId,
          });
        }
        throw error;
      }
      const buildStatus = String(build.buildStatus ?? "FAILED");
      const exitCode = buildStatus === "SUCCEEDED" ? 0 : 1;

      let stdout = "";
      if (options.captureLogs) {
        const logsRef = /** @type {{ logs?: { groupName?: string; streamName?: string } }} */ (build)?.logs;
        try {
          stdout = await readCloudWatchLogs({
            logs: /** @type {any} */ (options.logs),
            logGroupName: logsRef?.groupName,
            logStreamName: logsRef?.streamName,
            maxOutputBytes: options.maxOutputBytes,
            signal: execOpts.signal,
          });
        } catch (error) {
          if (execOpts.signal?.aborted) {
            await stop();
            throw new SmithersError(
              "SANDBOX_EXECUTION_FAILED",
              "AWS codebuild sandbox build was cancelled while reading logs.",
              { provider: AWS_SANDBOX_PROVIDER_ID, remoteId: buildId },
            );
          }
          throw error;
        }
      }
      const stderr = exitCode !== 0 ? scrubAwsSandboxSecrets(buildStatus, secrets) : "";
      return { exitCode, stdout, stderr };
    },
    stop,
  };
}

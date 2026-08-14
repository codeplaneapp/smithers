import { SmithersError } from "@smthrs/errors/SmithersError";
import { AWS_SANDBOX_PROVIDER_ID } from "./AWS_SANDBOX_PROVIDER_ID.js";
import { readCloudWatchLogs } from "./readCloudWatchLogs.js";
import { resolveAwsSdkClient } from "./resolveAwsSdkClient.js";
import { scrubAwsSandboxSecrets } from "./scrubAwsSandboxSecrets.js";

const POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * @param {Record<string, string>} env
 * @returns {Array<{ name: string; value: string }>}
 */
function toEcsEnvironment(env) {
  return Object.entries(env).map(([name, value]) => ({ name, value: String(value) }));
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
 * Build the Fargate (ECS RunTask) remote runner. It launches one task per exec,
 * polls DescribeTasks until the task stops, and returns the container's numeric
 * exit code. The actual request/result payload round-trips through S3; the task
 * command is `sh -c "<command>"`.
 *
 * @param {{
 *   client?: unknown;
 *   clientOptions?: Record<string, unknown>;
 *   cluster?: string;
 *   taskDefinition?: string;
 *   subnets?: string[];
 *   securityGroups?: string[];
 *   assignPublicIp?: "ENABLED" | "DISABLED";
 *   containerName?: string;
 *   captureLogs?: boolean;
 *   logs?: unknown;
 *   logGroupName?: string;
 *   awslogsStreamPrefix?: string;
 *   maxOutputBytes?: number;
 *   secrets?: string[];
 * }} options
 */
export async function createAwsEcsSandboxRunner(options) {
  const cluster = typeof options.cluster === "string" ? options.cluster.trim() : "";
  const taskDefinition = typeof options.taskDefinition === "string" ? options.taskDefinition.trim() : "";
  const containerName = typeof options.containerName === "string" ? options.containerName.trim() : "";
  const subnets = Array.isArray(options.subnets)
    ? options.subnets.filter((s) => typeof s === "string" && s.length > 0)
    : [];
  if (!cluster)
    throw new SmithersError("INVALID_INPUT", "AWS fargate sandbox requires a `cluster`.", {
      provider: AWS_SANDBOX_PROVIDER_ID,
    });
  if (!taskDefinition)
    throw new SmithersError("INVALID_INPUT", "AWS fargate sandbox requires a `taskDefinition`.", {
      provider: AWS_SANDBOX_PROVIDER_ID,
    });
  if (subnets.length === 0)
    throw new SmithersError("INVALID_INPUT", "AWS fargate sandbox requires at least one `subnets` entry.", {
      provider: AWS_SANDBOX_PROVIDER_ID,
    });
  if (!containerName)
    throw new SmithersError("INVALID_INPUT", "AWS fargate sandbox requires a `containerName`.", {
      provider: AWS_SANDBOX_PROVIDER_ID,
    });

  const ecs = await resolveAwsSdkClient({
    injected: options.client,
    moduleName: "@aws-sdk/client-ecs",
    clientExport: "ECSClient",
    methods: ["runTask", "describeTasks", "stopTask"],
    clientOptions: options.clientOptions,
  });
  const secrets = options.secrets ?? [];

  /** @type {string | undefined} */
  let taskArn;
  let stopped = false;

  /**
   * @param {string} taskArnToPoll
   * @param {{ timeoutMs: number; signal?: AbortSignal }} pollOpts
   * @returns {Promise<Record<string, any>>}
   */
  async function pollUntilStopped(taskArnToPoll, pollOpts) {
    const timeoutMs =
      Number.isFinite(pollOpts.timeoutMs) && pollOpts.timeoutMs > 0 ? pollOpts.timeoutMs : DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (pollOpts.signal?.aborted) {
        await stop();
        throw new SmithersError("SANDBOX_EXECUTION_FAILED", "AWS fargate sandbox task was cancelled.", {
          provider: AWS_SANDBOX_PROVIDER_ID,
          remoteId: taskArnToPoll,
        });
      }
      const res = await ecs.describeTasks({ cluster, tasks: [taskArnToPoll] }, { abortSignal: pollOpts.signal });
      const task = /** @type {{ tasks?: Array<Record<string, any>> }} */ (res)?.tasks?.[0];
      if (task && String(task.lastStatus) === "STOPPED") {
        // The task has already terminated on its own, so a later cleanup must
        // not issue a redundant StopTask against an already-stopped task.
        stopped = true;
        return task;
      }
      if (Date.now() >= deadline) {
        await stop(pollOpts.signal);
        throw new SmithersError(
          "SANDBOX_EXECUTION_FAILED",
          `AWS fargate sandbox task did not stop within ${timeoutMs}ms.`,
          { provider: AWS_SANDBOX_PROVIDER_ID, remoteId: taskArnToPoll },
        );
      }
      try {
        await sleep(POLL_INTERVAL_MS, pollOpts.signal);
      } catch {
        await stop();
        throw new SmithersError("SANDBOX_EXECUTION_FAILED", "AWS fargate sandbox task was cancelled.", {
          provider: AWS_SANDBOX_PROVIDER_ID,
          remoteId: taskArnToPoll,
        });
      }
    }
  }

  /**
   * @param {AbortSignal} [signal]
   */
  async function stop(signal) {
    if (!taskArn || stopped) return;
    stopped = true;
    try {
      await ecs.stopTask({ cluster, task: taskArn, reason: "smithers sandbox cleanup" }, { abortSignal: signal });
    } catch {
      // best-effort
    }
  }

  return {
    get remoteId() {
      return taskArn;
    },
    /**
     * @param {string} command
     * @param {{ env: Record<string, string>; timeoutMs: number; signal?: AbortSignal }} execOpts
     * @returns {Promise<{ exitCode: number; stdout: string; stderr: string }>}
     */
    async run(command, execOpts) {
      if (execOpts.signal?.aborted) {
        throw new SmithersError("SANDBOX_EXECUTION_FAILED", "AWS fargate sandbox task was cancelled before launch.", {
          provider: AWS_SANDBOX_PROVIDER_ID,
        });
      }
      const runInput = {
        cluster,
        taskDefinition,
        launchType: "FARGATE",
        count: 1,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets,
            ...(options.securityGroups && options.securityGroups.length > 0
              ? { securityGroups: options.securityGroups }
              : {}),
            assignPublicIp: options.assignPublicIp ?? "DISABLED",
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: containerName,
              command: ["sh", "-c", command],
              environment: toEcsEnvironment(execOpts.env),
            },
          ],
        },
      };
      let runRes;
      try {
        runRes = await ecs.runTask(runInput, { abortSignal: execOpts.signal });
      } catch (error) {
        if (execOpts.signal?.aborted) {
          throw new SmithersError("SANDBOX_EXECUTION_FAILED", "AWS fargate sandbox task was cancelled before launch.", {
            provider: AWS_SANDBOX_PROVIDER_ID,
          });
        }
        const detail = scrubAwsSandboxSecrets(error instanceof Error ? error.message : String(error), secrets);
        throw new SmithersError("SANDBOX_EXECUTION_FAILED", `AWS fargate RunTask failed: ${detail}`, {
          provider: AWS_SANDBOX_PROVIDER_ID,
        });
      }
      const failure = /** @type {{ failures?: Array<{ reason?: string }> }} */ (runRes)?.failures?.[0];
      taskArn = /** @type {{ tasks?: Array<{ taskArn?: string }> }} */ (runRes)?.tasks?.[0]?.taskArn;
      if (!taskArn) {
        const reason = scrubAwsSandboxSecrets(failure?.reason ?? "no task returned", secrets);
        throw new SmithersError("SANDBOX_EXECUTION_FAILED", `AWS fargate RunTask returned no task: ${reason}`, {
          provider: AWS_SANDBOX_PROVIDER_ID,
        });
      }

      let task;
      try {
        task = await pollUntilStopped(taskArn, { timeoutMs: execOpts.timeoutMs, signal: execOpts.signal });
      } catch (error) {
        // A remote task now exists. Attempt cleanup exactly once, but do not pass
        // an already-aborted signal because the cleanup request must still run.
        await stop();
        if (execOpts.signal?.aborted) {
          throw new SmithersError("SANDBOX_EXECUTION_FAILED", "AWS fargate sandbox task was cancelled.", {
            provider: AWS_SANDBOX_PROVIDER_ID,
            remoteId: taskArn,
          });
        }
        throw error;
      }
      const containers = /** @type {Array<{ name?: string; exitCode?: number }>} */ (task.containers ?? []);
      const container = containers.find((c) => c.name === containerName) ?? containers[0];
      const rawExit = container?.exitCode;
      const stoppedReason = task.stoppedReason;
      // A missing exitCode with a stoppedReason means the container never ran
      // (image pull error, task failure) — surface as a nonzero exit so the kit
      // throws instead of hunting for a result file that will never exist.
      const exitCode = typeof rawExit === "number" ? rawExit : stoppedReason ? 1 : 0;

      let stdout = "";
      if (options.captureLogs) {
        const taskId = String(taskArn).split("/").pop() ?? "";
        // awslogs stream name is `<streamPrefix>/<containerName>/<taskId>`. The
        // prefix defaults to the container name (matching a common awslogs
        // `awslogs-stream-prefix` convention) but is configurable for task
        // definitions that use a different prefix.
        const streamPrefix =
          typeof options.awslogsStreamPrefix === "string" && options.awslogsStreamPrefix.length > 0
            ? options.awslogsStreamPrefix
            : containerName;
        try {
          stdout = await readCloudWatchLogs({
            logs: /** @type {any} */ (options.logs),
            logGroupName: options.logGroupName,
            logStreamName: options.logGroupName ? `${streamPrefix}/${containerName}/${taskId}` : undefined,
            maxOutputBytes: options.maxOutputBytes,
            signal: execOpts.signal,
          });
        } catch (error) {
          if (execOpts.signal?.aborted) {
            await stop();
            throw new SmithersError(
              "SANDBOX_EXECUTION_FAILED",
              "AWS fargate sandbox task was cancelled while reading logs.",
              { provider: AWS_SANDBOX_PROVIDER_ID, remoteId: taskArn },
            );
          }
          throw error;
        }
      }
      const stderr = exitCode !== 0 && stoppedReason ? scrubAwsSandboxSecrets(String(stoppedReason), secrets) : "";
      return { exitCode, stdout, stderr };
    },
    stop,
  };
}

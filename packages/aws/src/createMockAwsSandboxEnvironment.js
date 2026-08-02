/**
 * @param {Array<{ name?: string; value?: unknown }> | undefined} list
 * @returns {Record<string, string>}
 */
function envFromList(list) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const entry of list ?? []) {
    if (entry && typeof entry.name === "string") out[entry.name] = String(entry.value ?? "");
  }
  return out;
}

/**
 * @param {unknown} buildspec
 * @returns {string}
 */
function extractBuildspecCommand(buildspec) {
  const match = String(buildspec ?? "").match(/-\s+(.+?)\s*$/m);
  if (!match) return "";
  try {
    return JSON.parse(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * In-memory AWS SDK doubles for the sandbox provider. Implements exactly the
 * subset each mode calls:
 *
 * - **S3** (`putObject`/`getObject`/`deleteObjects`) — a shared object store
 *   used as the bundle transport by both modes.
 * - **ECS** (`runTask`/`describeTasks`/`stopTask`) — fargate mode. `runTask`
 *   parses the request object from the store, calls `handler`, writes the
 *   result back to the store, and records a task that `describeTasks` reports as
 *   `STOPPED` with the configured exit code.
 * - **CodeBuild** (`startBuild`/`batchGetBuilds`/`stopBuild`) — codebuild mode.
 *   Same handler round-trip; `batchGetBuilds` reports the configured status.
 * - **CloudWatch Logs** (`getLogEvents`) — returns the configured `logEvents`.
 *
 * Fault injection (`faults.create|exec|upload|download`) reproduces launch, run,
 * upload, and download failures. Everything is deterministic and requires no AWS
 * credentials.
 *
 * @param {(args: { command: string; request: Record<string, unknown>; files: Map<string, string>; env: Record<string, string> }) => import("@smthrs/sandbox").SandboxProviderResult | Promise<import("@smthrs/sandbox").SandboxProviderResult>} handler
 * @param {{
 *   exitCode?: number;
 *   stoppedReason?: string;
 *   buildStatus?: string;
 *   writeResult?: boolean;
 *   logEvents?: string[];
 *   faultMessage?: string;
 *   faults?: { create?: boolean; exec?: boolean; upload?: boolean; download?: boolean };
 * }} [mockOptions]
 */
export function createMockAwsSandboxEnvironment(handler, mockOptions = {}) {
  /** @type {Map<string, string>} */
  const store = new Map();
  /** @type {{ create?: boolean; exec?: boolean; upload?: boolean; download?: boolean }} */
  const faults = { ...mockOptions.faults };
  const faultMessage = mockOptions.faultMessage ?? "mock aws sandbox fault";
  let ecsExitCode = mockOptions.exitCode ?? 0;
  let stoppedReason = mockOptions.stoppedReason;
  let buildStatus = mockOptions.buildStatus ?? "SUCCEEDED";
  let writeResult = mockOptions.writeResult !== false;
  let destroyed = false;
  let taskCounter = 0;
  let buildCounter = 0;
  /** @type {Map<string, { lastStatus: string; containerName?: string; exitCode: number; stoppedReason?: string }>} */
  const tasks = new Map();
  /** @type {Map<string, { buildStatus: string }>} */
  const builds = new Map();
  /** @type {string[]} */
  const stoppedTasks = [];
  /** @type {string[]} */
  const stoppedBuilds = [];
  /** @type {string} */
  let lastCommand = "";
  /** @type {Record<string, string>} */
  let lastEnv = {};

  /**
   * @param {Record<string, string>} env
   * @param {string} command
   * @returns {Promise<void>}
   */
  async function executeInSandbox(env, command) {
    lastCommand = command;
    lastEnv = env;
    const requestKey = env.SMITHERS_SANDBOX_REQUEST_S3_KEY;
    const resultKey = env.SMITHERS_SANDBOX_RESULT_S3_KEY;
    const request = JSON.parse(store.get(requestKey) ?? "{}");
    const files = new Map(store);
    const result = await handler({ command, request, files, env });
    if (writeResult && resultKey) store.set(resultKey, JSON.stringify(result));
  }

  const s3 = {
    /** @param {Record<string, unknown>} input */
    async putObject(input) {
      if (destroyed) throw new Error("mock AWS S3 used after destroy");
      if (faults.upload) throw new Error(`mock S3 PutObject fault: ${faultMessage}`);
      store.set(String(input.Key), typeof input.Body === "string" ? input.Body : String(input.Body));
      return {};
    },
    /** @param {Record<string, unknown>} input */
    async getObject(input) {
      if (faults.download) throw new Error(`mock S3 GetObject fault: ${faultMessage}`);
      const key = String(input.Key);
      if (!store.has(key)) throw new Error(`mock S3 NoSuchKey: ${key}`);
      const content = store.get(key) ?? "";
      return { Body: { transformToString: async () => content } };
    },
    /** @param {Record<string, any>} input */
    async deleteObjects(input) {
      const objects = input?.Delete?.Objects ?? [];
      for (const obj of objects) store.delete(String(obj.Key));
      return { Deleted: objects };
    },
  };

  const ecs = {
    /** @param {Record<string, any>} input */
    async runTask(input) {
      if (destroyed) throw new Error("mock AWS ECS used after destroy");
      if (faults.create) throw new Error(`mock ECS RunTask fault: ${faultMessage}`);
      const container = input?.overrides?.containerOverrides?.[0];
      const env = envFromList(container?.environment);
      const commandArr = container?.command;
      const command = Array.isArray(commandArr) ? String(commandArr[commandArr.length - 1]) : "";
      const arn = `arn:aws:ecs:us-east-1:000000000000:task/${input.cluster}/${++taskCounter}`;
      let exitCode = ecsExitCode;
      let reason = stoppedReason;
      if (faults.exec) {
        exitCode = ecsExitCode || 1;
        reason = stoppedReason ?? "EssentialContainerExited";
        lastCommand = command;
        lastEnv = env;
      } else {
        await executeInSandbox(env, command);
      }
      tasks.set(arn, { lastStatus: "STOPPED", containerName: container?.name, exitCode, stoppedReason: reason });
      return { tasks: [{ taskArn: arn, lastStatus: "PROVISIONING" }], failures: [] };
    },
    /** @param {Record<string, any>} input */
    async describeTasks(input) {
      const arn = String(input?.tasks?.[0]);
      const task = tasks.get(arn);
      if (!task) return { tasks: [], failures: [{ arn, reason: "MISSING" }] };
      return {
        tasks: [
          {
            taskArn: arn,
            lastStatus: task.lastStatus,
            stoppedReason: task.stoppedReason,
            containers: [{ name: task.containerName, exitCode: task.exitCode }],
          },
        ],
      };
    },
    /** @param {Record<string, any>} input */
    async stopTask(input) {
      const task = tasks.get(String(input.task));
      if (task) task.lastStatus = "STOPPED";
      stoppedTasks.push(String(input.task));
      return { task: { taskArn: input.task } };
    },
  };

  const codebuild = {
    /** @param {Record<string, any>} input */
    async startBuild(input) {
      if (destroyed) throw new Error("mock AWS CodeBuild used after destroy");
      if (faults.create) throw new Error(`mock CodeBuild StartBuild fault: ${faultMessage}`);
      const env = envFromList(input?.environmentVariablesOverride);
      const command = extractBuildspecCommand(input?.buildspecOverride);
      const id = `${input.projectName}:${++buildCounter}`;
      let status = buildStatus;
      if (faults.exec) {
        status = "FAILED";
        lastCommand = command;
        lastEnv = env;
      } else {
        await executeInSandbox(env, command);
      }
      builds.set(id, { buildStatus: status });
      return { build: { id, buildStatus: "IN_PROGRESS" } };
    },
    /** @param {Record<string, any>} input */
    async batchGetBuilds(input) {
      const id = String(input?.ids?.[0]);
      const build = builds.get(id);
      if (!build) return { builds: [] };
      return {
        builds: [{ id, buildStatus: build.buildStatus, logs: { groupName: "/aws/codebuild/mock", streamName: id } }],
      };
    },
    /** @param {Record<string, any>} input */
    async stopBuild(input) {
      const build = builds.get(String(input.id));
      if (build) build.buildStatus = "STOPPED";
      stoppedBuilds.push(String(input.id));
      return { build: { id: input.id, buildStatus: "STOPPED" } };
    },
  };

  const logs = {
    async getLogEvents() {
      return { events: (mockOptions.logEvents ?? []).map((message) => ({ message })) };
    },
  };

  return {
    s3,
    ecs,
    codebuild,
    logs,
    store,
    get command() {
      return lastCommand;
    },
    get env() {
      return lastEnv;
    },
    get stoppedTasks() {
      return stoppedTasks;
    },
    get stoppedBuilds() {
      return stoppedBuilds;
    },
    get destroyed() {
      return destroyed;
    },
    /** @param {number} value */
    setExitCode(value) {
      ecsExitCode = value;
    },
    /** @param {string | undefined} value */
    setStoppedReason(value) {
      stoppedReason = value;
    },
    /** @param {string} value */
    setBuildStatus(value) {
      buildStatus = value;
    },
    /** @param {boolean} value */
    setWriteResult(value) {
      writeResult = value;
    },
    /**
     * @param {"create" | "exec" | "upload" | "download"} name
     * @param {boolean} [on]
     */
    setFault(name, on = true) {
      faults[name] = on;
    },
    destroy() {
      destroyed = true;
    },
  };
}

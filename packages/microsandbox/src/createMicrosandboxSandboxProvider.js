import { createHash } from "node:crypto";
import { posix } from "node:path";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { createCommandSandboxProvider } from "@smithers-orchestrator/sandbox";
import { MICROSANDBOX_PROVIDER_ID } from "./MICROSANDBOX_PROVIDER_ID.js";

const DEFAULT_IMAGE = "oven/bun:1";
const DEFAULT_COMMAND = "bun /workspace/run-smithers-sandbox.js";
const DEFAULT_WORKDIR = "/workspace";
const DEFAULT_SHELL = "/bin/sh";
const MAX_SANDBOX_NAME_BYTES = 128;
const SECRET_KEY_RE = /token|secret|key|password|credential|authorization|passwd|apikey/i;

/**
 * Build a Smithers SandboxProvider backed by local Microsandbox microVMs.
 *
 * The shared provider-kit owns request/result serialization, egress env,
 * result parsing, and provider cleanup. This factory maps its SandboxSession
 * seam onto the Microsandbox TypeScript SDK.
 *
 * @param {import("./MicrosandboxSandboxProviderOptions.ts").MicrosandboxSandboxProviderOptions} [options]
 * @returns {import("@smithers-orchestrator/sandbox").SandboxProvider}
 */
export function createMicrosandboxSandboxProvider(options = {}) {
  validateFactoryOptions(options);
  const id = options.id ?? MICROSANDBOX_PROVIDER_ID;
  const workdir = options.workdir ?? DEFAULT_WORKDIR;
  const cleanup = options.cleanup ?? "destroy";

  return createCommandSandboxProvider({
    id,
    command: options.command ?? DEFAULT_COMMAND,
    workdir,
    env: options.env,
    cleanup,
    createSession: async (request) => {
      const sdk = await resolveMicrosandboxSdk(options, id);
      const config = asRecord(request.config);
      const workspace = normalizeWorkspace(config.workspace);
      const sticky = workspace?.persistence === "sticky";
      const detached = options.detached ?? cleanup === "keep";
      const ephemeral = sticky ? false : (options.ephemeral ?? cleanup !== "keep");
      const name = resolveSandboxName(options.sandboxName, workspace, request);
      const creationTimeoutMs = options.creationTimeoutMs ?? request.toolTimeoutMs;
      const secretValues = collectSecretValues(options.env, config.env);
      let sandbox;
      let createdNew = false;

      try {
        if (sticky) {
          sandbox = await openStickySandbox(sdk, name, detached, request.signal, creationTimeoutMs);
        }

        if (!sandbox) {
          const builder = configureSandboxBuilder(sdk.Sandbox.builder(name), options, request, {
            config,
            workspace,
            workdir,
            detached,
            ephemeral,
            sticky,
          });
          const createPromise = Promise.resolve().then(() => builder.create());
          try {
            sandbox = await raceWithAbort(createPromise, request.signal, creationTimeoutMs, {
              abortMessage: "Microsandbox creation aborted.",
              timeoutMessage: `Microsandbox creation timed out after ${creationTimeoutMs}ms.`,
            });
            createdNew = true;
          } catch (error) {
            disposeSandboxWhenReady(sdk, name, createPromise, options.stopTimeoutMs);
            throw error;
          }
        }

        await ensureGuestDirectory(sandbox.fs(), workdir);
        await uploadSetupFiles(sandbox.fs(), options.setupFiles);
      } catch (error) {
        if (sandbox) {
          await disposeSandboxQuietly(sdk, name, sandbox, {
            remove: createdNew && !sticky,
            stopTimeoutMs: options.stopTimeoutMs,
          });
        }
        if (error instanceof SmithersError) throw error;
        throw new SmithersError(
          "SANDBOX_EXECUTION_FAILED",
          `Microsandbox creation failed: ${scrubSecrets(messageOf(error), secretValues)}`,
          { provider: id, remoteId: name },
        );
      }

      const activeSandbox = sandbox;
      return {
        remoteId: name,
        async writeFile(path, content) {
          await ensureGuestParentDirectory(activeSandbox.fs(), path);
          await activeSandbox.fs().write(path, content);
        },
        async readFile(path) {
          return activeSandbox.fs().readToString(path);
        },
        async exec(command, { cwd, env, timeoutMs, signal }) {
          if (signal?.aborted) {
            throw new Error("Microsandbox command aborted before it started.");
          }
          const requestCommand = pickString(config.command);
          const effectiveCommand = options.command ?? requestCommand ?? command;
          const requestEnv = normalizeStringRecord(config.env, "Sandbox env") ?? {};
          const effectiveEnv = { ...requestEnv, ...env };
          const shell = options.shell ?? DEFAULT_SHELL;
          const handle = await activeSandbox.execStreamWith(shell, (builder) => {
            let configured = builder.args(["-lc", effectiveCommand]).cwd(cwd).envs(effectiveEnv);
            if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
              configured = configured.timeout(timeoutMs);
            }
            return configured;
          });
          const output = await collectExecOutput(handle, signal, timeoutMs);
          return {
            exitCode: Number(output.code ?? 0),
            stdout: String(output.stdout()),
            stderr: String(output.stderr()),
          };
        },
        async destroy() {
          try {
            await disposeSandbox(sdk, name, activeSandbox, {
              remove: !sticky && !ephemeral,
              stopTimeoutMs: options.stopTimeoutMs,
            });
          } catch (error) {
            throw new SmithersError(
              "SANDBOX_EXECUTION_FAILED",
              `Microsandbox cleanup failed: ${scrubSecrets(messageOf(error), secretValues)}`,
              { provider: id, remoteId: name },
            );
          }
        },
      };
    },
  });
}

/**
 * @param {import("./MicrosandboxSandboxProviderOptions.ts").MicrosandboxSandboxProviderOptions} options
 */
function validateFactoryOptions(options) {
  if (options.image && options.snapshot) {
    invalid("Microsandbox provider accepts either image or snapshot, not both.");
  }
  if (options.image !== undefined && !pickString(options.image))
    invalid("Microsandbox image must be a non-empty string.");
  if (options.snapshot !== undefined && !pickString(options.snapshot))
    invalid("Microsandbox snapshot must be a non-empty string.");
  const workdir = options.workdir ?? DEFAULT_WORKDIR;
  if (!isAbsoluteGuestPath(workdir)) invalid("Microsandbox workdir must be an absolute guest path.", { workdir });
  const shell = options.shell ?? DEFAULT_SHELL;
  if (!isAbsoluteGuestPath(shell)) invalid("Microsandbox shell must be an absolute guest path.", { shell });
  validatePositiveInteger(options.cpus, "cpus");
  validatePositiveInteger(options.maxCpus, "maxCpus");
  validatePositiveInteger(options.memoryMib, "memoryMib");
  validatePositiveInteger(options.maxMemoryMib, "maxMemoryMib");
  validatePositiveNumber(options.maxDurationSecs, "maxDurationSecs");
  validateNonNegativeNumber(options.idleTimeoutSecs, "idleTimeoutSecs");
  validatePositiveNumber(options.creationTimeoutMs, "creationTimeoutMs");
  validateNonNegativeNumber(options.replaceTimeoutMs, "replaceTimeoutMs");
  validateNonNegativeNumber(options.stopTimeoutMs, "stopTimeoutMs");
  if (options.maxCpus !== undefined && options.cpus !== undefined && options.maxCpus < options.cpus) {
    invalid("Microsandbox maxCpus must be greater than or equal to cpus.");
  }
  if (
    options.maxMemoryMib !== undefined &&
    options.memoryMib !== undefined &&
    options.maxMemoryMib < options.memoryMib
  ) {
    invalid("Microsandbox maxMemoryMib must be greater than or equal to memoryMib.");
  }
  for (const path of Object.keys(options.setupFiles ?? {})) {
    if (!isAbsoluteGuestPath(path)) invalid("Microsandbox setupFiles keys must be absolute guest paths.", { path });
  }
}

/**
 * @param {import("./MicrosandboxSandboxProviderOptions.ts").MicrosandboxSandboxBuilderLike} builder
 * @param {import("./MicrosandboxSandboxProviderOptions.ts").MicrosandboxSandboxProviderOptions} options
 * @param {import("@smithers-orchestrator/sandbox").SandboxProviderRequest} request
 * @param {{
 *   config: Record<string, unknown>;
 *   workspace: { name?: string; snapshotId?: string; idleTimeoutSecs?: number; persistence?: "ephemeral" | "sticky" } | undefined;
 *   workdir: string;
 *   detached: boolean;
 *   ephemeral: boolean;
 *   sticky: boolean;
 * }} resolved
 */
function configureSandboxBuilder(builder, options, request, resolved) {
  const { config, workspace, workdir, detached, ephemeral, sticky } = resolved;
  const snapshot = workspace?.snapshotId ?? pickString(config.snapshot) ?? options.snapshot;
  const image = snapshot ? undefined : (pickString(config.image) ?? options.image ?? DEFAULT_IMAGE);
  if (snapshot) builder = builder.fromSnapshot(snapshot);
  else builder = builder.image(image);

  const resources = asRecord(config.resources);
  const cpus = normalizeCpuCount(config.cpus ?? resources.cpu ?? config.cpuLimit, options.cpus);
  const memoryMib = normalizeMemoryMib(config.memoryMib ?? resources.memory ?? config.memoryLimit, options.memoryMib);
  if (cpus !== undefined) builder = builder.cpus(cpus);
  if (options.maxCpus !== undefined) builder = builder.maxCpus(options.maxCpus);
  if (memoryMib !== undefined) builder = builder.memory(memoryMib);
  if (options.maxMemoryMib !== undefined) builder = builder.maxMemory(options.maxMemoryMib);

  // Microsandbox validates the builder workdir against the unbooted image.
  // Smithers workdirs may be created by this adapter after boot, so keep the
  // image's valid default here and pass the ensured path to every exec instead.
  builder = builder.ephemeral(ephemeral).detached(detached);
  if (options.security) builder = builder.security(options.security);
  if (options.pullPolicy) builder = builder.pullPolicy(options.pullPolicy);
  if (options.labels && Object.keys(options.labels).length > 0) builder = builder.labels(options.labels);
  if (options.scripts && Object.keys(options.scripts).length > 0) builder = builder.scripts(options.scripts);
  if (options.maxDurationSecs !== undefined) builder = builder.maxDuration(options.maxDurationSecs);
  const idleTimeoutSecs = workspace?.idleTimeoutSecs ?? options.idleTimeoutSecs;
  if (idleTimeoutSecs !== undefined) builder = builder.idleTimeout(idleTimeoutSecs);

  const ports = normalizePorts(config.ports);
  if (!request.allowNetwork) {
    if (ports.length > 0) invalid("Microsandbox port publishing requires allowNetwork=true.");
    builder = builder.disableNetwork();
  } else {
    for (const port of ports) builder = builder.port(port.host, port.container);
  }

  for (const volume of normalizeVolumes(config.volumes, workdir)) {
    builder = builder.volume(volume.container, (mount) => {
      let configured = mount.bind(volume.host);
      if (volume.readonly !== false) configured = configured.readonly();
      return configured;
    });
  }

  if (!sticky && options.replaceExisting !== false) {
    builder =
      options.replaceTimeoutMs === undefined ? builder.replace() : builder.replaceWithTimeout(options.replaceTimeoutMs);
  }
  const custom = options.configureBuilder?.(builder, request);
  return custom ?? builder;
}

/**
 * @param {import("./MicrosandboxSandboxProviderOptions.ts").MicrosandboxSandboxProviderOptions} options
 * @param {string} id
 * @returns {Promise<import("./MicrosandboxSandboxProviderOptions.ts").MicrosandboxSdkLike>}
 */
async function resolveMicrosandboxSdk(options, id) {
  if (options.sdk) return options.sdk;
  let mod;
  try {
    mod = await (options.importSdk ? options.importSdk() : import("microsandbox"));
  } catch (error) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Microsandbox SDK is not installed. Run "npm install microsandbox@0.6.6" (or pass options.sdk). Original error: ${messageOf(error)}`,
      { provider: id },
    );
  }
  const Sandbox = mod?.Sandbox ?? mod?.default?.Sandbox;
  if (
    !Sandbox ||
    typeof Sandbox.builder !== "function" ||
    typeof Sandbox.get !== "function" ||
    typeof Sandbox.remove !== "function"
  ) {
    throw new SmithersError("INVALID_INPUT", "Microsandbox SDK does not export the expected Sandbox API.", {
      provider: id,
    });
  }
  return { Sandbox };
}

/**
 * @param {import("./MicrosandboxSandboxProviderOptions.ts").MicrosandboxSdkLike} sdk
 * @param {string} name
 * @param {boolean} detached
 * @param {AbortSignal | undefined} signal
 * @param {number} timeoutMs
 * @returns {Promise<import("./MicrosandboxSandboxProviderOptions.ts").MicrosandboxSandboxLike | undefined>}
 */
async function openStickySandbox(sdk, name, detached, signal, timeoutMs) {
  let handle;
  try {
    handle = await raceWithAbort(sdk.Sandbox.get(name), signal, timeoutMs, {
      abortMessage: "Microsandbox workspace lookup aborted.",
      timeoutMessage: `Microsandbox workspace lookup timed out after ${timeoutMs}ms.`,
    });
  } catch (error) {
    if (isSandboxNotFound(error)) return undefined;
    throw error;
  }
  if (handle.status === "running") {
    const connect = handle.connectWithTimeout
      ? handle.connectWithTimeout.bind(handle, timeoutMs)
      : handle.connect.bind(handle);
    return raceWithAbort(Promise.resolve().then(connect), signal, timeoutMs, {
      abortMessage: "Microsandbox workspace connection aborted.",
      timeoutMessage: `Microsandbox workspace connection timed out after ${timeoutMs}ms.`,
    });
  }
  if (handle.status === "draining") {
    throw new SmithersError("SANDBOX_EXECUTION_FAILED", `Microsandbox workspace "${name}" is draining.`, {
      remoteId: name,
    });
  }
  const start = detached ? handle.startDetached.bind(handle) : handle.start.bind(handle);
  return raceWithAbort(Promise.resolve().then(start), signal, timeoutMs, {
    abortMessage: "Microsandbox workspace start aborted.",
    timeoutMessage: `Microsandbox workspace start timed out after ${timeoutMs}ms.`,
  });
}

/**
 * @param {import("./MicrosandboxSandboxProviderOptions.ts").MicrosandboxExecHandleLike} handle
 * @param {AbortSignal | undefined} signal
 * @param {number} timeoutMs
 */
async function collectExecOutput(handle, signal, timeoutMs) {
  try {
    return await raceWithAbort(handle.collect(), signal, timeoutMs, {
      abortMessage: "Microsandbox command aborted.",
      timeoutMessage: `Microsandbox command timed out after ${timeoutMs}ms.`,
      onCancel: () => handle.kill(),
    });
  } catch (error) {
    await Promise.resolve(handle.kill()).catch(() => undefined);
    throw error;
  }
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal | undefined} signal
 * @param {number} timeoutMs
 * @param {{ abortMessage: string; timeoutMessage: string; onCancel?: () => unknown }} messages
 * @returns {Promise<T>}
 */
function raceWithAbort(promise, signal, timeoutMs, messages) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const cancel = (message) => {
      try {
        void Promise.resolve(messages.onCancel?.()).catch(() => undefined);
      } catch {
        // Preserve the timeout/abort error.
      }
      finish(reject, new Error(message));
    };
    const onAbort = () => cancel(messages.abortMessage);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => cancel(messages.timeoutMessage), timeoutMs);
    }
    promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

/** @param {import("./MicrosandboxSandboxProviderOptions.ts").MicrosandboxFsLike} fs @param {string} filePath */
async function ensureGuestParentDirectory(fs, filePath) {
  await ensureGuestDirectory(fs, posix.dirname(filePath));
}

/** @param {import("./MicrosandboxSandboxProviderOptions.ts").MicrosandboxFsLike} fs @param {string} directory */
async function ensureGuestDirectory(fs, directory) {
  if (!isAbsoluteGuestPath(directory)) invalid("Microsandbox guest paths must be absolute.", { path: directory });
  let current = "";
  for (const part of directory.split("/").filter(Boolean)) {
    current += `/${part}`;
    if (!(await fs.exists(current))) await fs.mkdir(current);
  }
}

/**
 * @param {import("./MicrosandboxSandboxProviderOptions.ts").MicrosandboxFsLike} fs
 * @param {Record<string, import("./MicrosandboxSandboxProviderOptions.ts").MicrosandboxSetupFile> | undefined} files
 */
async function uploadSetupFiles(fs, files) {
  for (const [path, content] of Object.entries(files ?? {})) {
    await ensureGuestParentDirectory(fs, path);
    await fs.write(path, content);
  }
}

/**
 * @param {import("./MicrosandboxSandboxProviderOptions.ts").MicrosandboxSdkLike} sdk
 * @param {string} name
 * @param {Promise<import("./MicrosandboxSandboxProviderOptions.ts").MicrosandboxSandboxLike>} promise
 * @param {number | undefined} stopTimeoutMs
 */
function disposeSandboxWhenReady(sdk, name, promise, stopTimeoutMs) {
  void promise.then(
    (sandbox) => disposeSandboxQuietly(sdk, name, sandbox, { remove: true, stopTimeoutMs }),
    () => undefined,
  );
}

/**
 * @param {import("./MicrosandboxSandboxProviderOptions.ts").MicrosandboxSdkLike} sdk
 * @param {string} name
 * @param {import("./MicrosandboxSandboxProviderOptions.ts").MicrosandboxSandboxLike} sandbox
 * @param {{ remove: boolean; stopTimeoutMs?: number }} options
 */
async function disposeSandbox(sdk, name, sandbox, options) {
  if (options.stopTimeoutMs !== undefined && typeof sandbox.stopWithTimeout === "function") {
    await sandbox.stopWithTimeout(options.stopTimeoutMs);
  } else {
    await sandbox.stop();
  }
  if (!options.remove) return;
  try {
    await sdk.Sandbox.remove(name);
  } catch (error) {
    if (!isSandboxNotFound(error)) throw error;
  }
}

/** Same as disposeSandbox, preserving the primary error. */
async function disposeSandboxQuietly(sdk, name, sandbox, options) {
  try {
    await disposeSandbox(sdk, name, sandbox, options);
  } catch {
    // Best-effort cleanup.
  }
}

/**
 * @param {string | ((request: import("@smithers-orchestrator/sandbox").SandboxProviderRequest) => string) | undefined} configured
 * @param {{ name?: string; persistence?: string } | undefined} workspace
 * @param {import("@smithers-orchestrator/sandbox").SandboxProviderRequest} request
 */
function resolveSandboxName(configured, workspace, request) {
  const workspaceName = workspace?.name;
  const derivedWorkspaceName =
    workspaceName && workspace?.persistence === "sticky"
      ? workspaceName
      : workspaceName
        ? `${workspaceName}-${request.runId}-${request.sandboxId}`
        : undefined;
  const raw =
    typeof configured === "function"
      ? configured(request)
      : (configured ?? derivedWorkspaceName ?? `smithers-${request.runId}-${request.sandboxId}`);
  if (typeof raw !== "string" || raw.trim().length === 0)
    invalid("Microsandbox sandboxName must resolve to a non-empty string.");
  return sanitizeSandboxName(raw);
}

/** @param {string} raw */
function sanitizeSandboxName(raw) {
  const trimmed = raw.trim();
  let normalized = trimmed.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  if (!normalized) normalized = "smithers";
  const changed = normalized !== trimmed;
  const hash = createHash("sha256").update(trimmed).digest("hex").slice(0, 10);
  if (changed) normalized = `${normalized}-${hash}`;
  if (Buffer.byteLength(normalized) <= MAX_SANDBOX_NAME_BYTES) return normalized;
  const suffix = `-${hash}`;
  return `${normalized.slice(0, MAX_SANDBOX_NAME_BYTES - suffix.length)}${suffix}`;
}

/** @param {unknown} value */
function normalizeWorkspace(value) {
  if (value === undefined) return undefined;
  const source = requireRecord(value, "Sandbox workspace");
  const workspace = {};
  if (source.name !== undefined) {
    if (typeof source.name !== "string" || source.name.trim().length === 0)
      invalid("Sandbox workspace name must be non-empty.");
    workspace.name = source.name.trim();
  }
  if (source.snapshotId !== undefined) {
    if (typeof source.snapshotId !== "string" || source.snapshotId.trim().length === 0)
      invalid("Sandbox workspace snapshotId must be non-empty.");
    workspace.snapshotId = source.snapshotId.trim();
  }
  if (source.idleTimeoutSecs !== undefined) {
    validateNonNegativeNumber(source.idleTimeoutSecs, "workspace.idleTimeoutSecs");
    workspace.idleTimeoutSecs = source.idleTimeoutSecs;
  }
  if (source.persistence !== undefined) {
    if (source.persistence !== "ephemeral" && source.persistence !== "sticky")
      invalid("Sandbox workspace persistence must be ephemeral or sticky.");
    workspace.persistence = source.persistence;
  }
  return workspace;
}

/** @param {unknown} value */
function normalizePorts(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid("Sandbox ports must be an array of { host, container } mappings.");
  return value.map((entry, index) => {
    const port = requireRecord(entry, `ports[${index}]`);
    return {
      host: normalizePort(port.host, `ports[${index}].host`),
      container: normalizePort(port.container, `ports[${index}].container`),
    };
  });
}

/** @param {unknown} value @param {string} workdir */
function normalizeVolumes(value, workdir) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid("Sandbox volumes must be an array of { host, container, readonly } mappings.");
  return value.map((entry, index) => {
    const volume = requireRecord(entry, `volumes[${index}]`);
    if (typeof volume.host !== "string" || !volume.host.startsWith("/"))
      invalid(`volumes[${index}].host must be an absolute host path.`);
    if (typeof volume.container !== "string" || !isAbsoluteGuestPath(volume.container))
      invalid(`volumes[${index}].container must be an absolute guest path.`);
    if (pathsOverlap(volume.container, workdir)) {
      invalid("Microsandbox volumes may not overlap the provider workdir.", { container: volume.container, workdir });
    }
    return {
      host: volume.host,
      container: volume.container,
      readonly: volume.readonly === undefined ? true : Boolean(volume.readonly),
    };
  });
}

/** @param {unknown} value @param {number | undefined} fallback */
function normalizeCpuCount(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0)
    invalid("Sandbox cpuLimit must be a positive number.");
  return Math.ceil(parsed);
}

/** @param {unknown} value @param {number | undefined} fallback */
function normalizeMemoryMib(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) invalid("Sandbox memory must be a positive MiB value.");
    return Math.ceil(value);
  }
  if (typeof value !== "string") invalid("Sandbox memoryLimit must be a Docker-style size string.");
  const match = /^([1-9][0-9]*)([bkmg]?)$/i.exec(value);
  if (!match) invalid("Sandbox memoryLimit must use optional b, k, m, or g units.");
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const bytes = amount * { "": 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[unit];
  return Math.max(1, Math.ceil(bytes / 1024 ** 2));
}

/** @param {unknown} value @param {string} field */
function normalizePort(value, field) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid(`${field} must be an integer from 1 to 65535.`);
  return port;
}

/** @param {unknown} value @param {string} field */
function requireRecord(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${field} must be an object.`);
  return value;
}

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** @param {unknown} value @param {string} field */
function normalizeStringRecord(value, field) {
  if (value === undefined) return undefined;
  const source = requireRecord(value, field);
  const out = {};
  for (const [key, entry] of Object.entries(source)) {
    if (typeof entry !== "string") invalid(`${field} values must be strings.`, { key });
    out[key] = entry;
  }
  return out;
}

/** @param {unknown} value */
function pickString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** @param {unknown} error */
function isSandboxNotFound(error) {
  return Boolean(error && typeof error === "object" && error.code === "sandboxNotFound");
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {Record<string, string> | undefined} providerEnv @param {unknown} requestEnv */
function collectSecretValues(providerEnv, requestEnv) {
  const values = [];
  for (const source of [providerEnv ?? {}, asRecord(requestEnv)]) {
    for (const [key, value] of Object.entries(source)) {
      if (SECRET_KEY_RE.test(key) && typeof value === "string" && value.length > 0) values.push(value);
    }
  }
  return values;
}

/** @param {string} message @param {string[]} secrets */
function scrubSecrets(message, secrets) {
  let out = message;
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  return out;
}

/** @param {string} left @param {string} right */
function pathsOverlap(left, right) {
  const a = left.replace(/\/+$/g, "") || "/";
  const b = right.replace(/\/+$/g, "") || "/";
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** @param {unknown} value */
function isAbsoluteGuestPath(value) {
  return typeof value === "string" && value.startsWith("/") && !value.includes("\0");
}

/** @param {unknown} value @param {string} field */
function validatePositiveInteger(value, field) {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0))
    invalid(`Microsandbox ${field} must be a positive integer.`);
}

/** @param {unknown} value @param {string} field */
function validatePositiveNumber(value, field) {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0))
    invalid(`Microsandbox ${field} must be a positive number.`);
}

/** @param {unknown} value @param {string} field */
function validateNonNegativeNumber(value, field) {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0))
    invalid(`Microsandbox ${field} must be a non-negative number.`);
}

/** @param {string} message @param {Record<string, unknown>} [details] @returns {never} */
function invalid(message, details = {}) {
  throw new SmithersError("INVALID_INPUT", message, details);
}

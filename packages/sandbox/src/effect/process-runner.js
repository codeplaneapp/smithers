import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawnCaptureEffect } from "@smithers-orchestrator/driver/child-process";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { Effect } from "effect";

const DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SANDBOX_OUTPUT_BYTES = 5 * 1024 * 1024;
const DEFAULT_DOCKER_IMAGE = "oven/bun:1";
const SANDBOX_DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";
const RUNNER_ENV_ALLOWLIST = [
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "XDG_RUNTIME_DIR",
];
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MEMORY_LIMIT_RE = /^[1-9][0-9]*(?:[bkmgBKMG])?$/;
const CPU_LIMIT_RE = /^(?:[1-9][0-9]*(?:\.[0-9]+)?|0?\.[0-9]+)$/;

/**
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {never}
 */
function invalidSandboxConfig(message, details = {}) {
    throw new SmithersError("INVALID_INPUT", message, details);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * @returns {Record<string, string>}
 */
export function sandboxRunnerEnv() {
    const env = {};
    for (const key of RUNNER_ENV_ALLOWLIST) {
        const value = process.env[key];
        if (typeof value === "string" && value.length > 0 && !value.includes("\0")) {
            env[key] = value;
        }
    }
    if (!env.PATH) {
        env.PATH = SANDBOX_DEFAULT_PATH;
    }
    return env;
}

/**
 * @param {unknown} env
 * @param {{ includeDefaultPath?: boolean }} [options]
 * @returns {Record<string, string>}
 */
export function normalizeSandboxEnv(env, options = {}) {
    const normalized = {};
    if (env !== undefined) {
        if (!isPlainObject(env)) {
            invalidSandboxConfig("Sandbox env must be a flat object of string values.");
        }
        for (const [key, value] of Object.entries(env)) {
            if (!ENV_NAME_RE.test(key)) {
                invalidSandboxConfig("Sandbox env keys must be valid environment variable names.", { envKey: key });
            }
            if (typeof value !== "string") {
                invalidSandboxConfig("Sandbox env values must be strings.", { envKey: key });
            }
            if (key.length > 128 || value.length > 64 * 1024 || value.includes("\0")) {
                invalidSandboxConfig("Sandbox env entry is outside supported bounds.", { envKey: key });
            }
            normalized[key] = value;
        }
    }
    if (options.includeDefaultPath && !normalized.PATH) {
        normalized.PATH = SANDBOX_DEFAULT_PATH;
    }
    return normalized;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
function normalizePort(value, field) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        invalidSandboxConfig(`${field} must be an integer port between 1 and 65535.`, { field });
    }
    return port;
}

/**
 * @param {unknown} ports
 * @returns {Array<{ host: number; container: number }>}
 */
export function normalizeSandboxPorts(ports) {
    if (ports === undefined) {
        return [];
    }
    if (!Array.isArray(ports)) {
        invalidSandboxConfig("Sandbox ports must be an array of { host, container } mappings.");
    }
    return ports.map((port, index) => {
        if (!isPlainObject(port)) {
            invalidSandboxConfig("Sandbox port mappings must be objects.", { index });
        }
        return {
            host: normalizePort(port.host, `ports[${index}].host`),
            container: normalizePort(port.container, `ports[${index}].container`),
        };
    });
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function normalizeAbsolutePath(value, field) {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !isAbsolute(value)) {
        invalidSandboxConfig(`${field} must be an absolute path.`, { field });
    }
    return value;
}

/**
 * @param {unknown} volumes
 * @returns {Array<{ host: string; container: string; readonly?: boolean }>}
 */
export function normalizeSandboxVolumes(volumes) {
    if (volumes === undefined) {
        return [];
    }
    if (!Array.isArray(volumes)) {
        invalidSandboxConfig("Sandbox volumes must be an array of { host, container, readonly } mappings.");
    }
    return volumes.map((volume, index) => {
        if (!isPlainObject(volume)) {
            invalidSandboxConfig("Sandbox volume mappings must be objects.", { index });
        }
        return {
            host: normalizeAbsolutePath(volume.host, `volumes[${index}].host`),
            container: normalizeAbsolutePath(volume.container, `volumes[${index}].container`),
            ...(volume.readonly === undefined ? {} : { readonly: Boolean(volume.readonly) }),
        };
    });
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {RegExp} pattern
 * @returns {string | undefined}
 */
function normalizeResourceLimit(value, field, pattern) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "string" || !pattern.test(value) || value.includes("\0")) {
        invalidSandboxConfig(`${field} is not a supported sandbox resource limit.`, { field });
    }
    return value;
}

/**
 * @param {unknown} workspace
 * @returns {{ name: string; snapshotId?: string; idleTimeoutSecs?: number; persistence?: "ephemeral" | "sticky" } | undefined}
 */
function normalizeSandboxWorkspace(workspace) {
    if (workspace === undefined) {
        return undefined;
    }
    if (!isPlainObject(workspace) || typeof workspace.name !== "string" || workspace.name.trim().length === 0) {
        invalidSandboxConfig("Sandbox workspace must include a non-empty name.");
    }
    const out = { name: workspace.name.trim() };
    if (workspace.snapshotId !== undefined) {
        if (typeof workspace.snapshotId !== "string" || workspace.snapshotId.trim().length === 0) {
            invalidSandboxConfig("Sandbox workspace snapshotId must be a non-empty string.");
        }
        out.snapshotId = workspace.snapshotId.trim();
    }
    if (workspace.idleTimeoutSecs !== undefined) {
        const secs = Number(workspace.idleTimeoutSecs);
        if (!Number.isFinite(secs) || secs < 0) {
            invalidSandboxConfig("Sandbox workspace idleTimeoutSecs must be a non-negative number.");
        }
        out.idleTimeoutSecs = Math.floor(secs);
    }
    if (workspace.persistence !== undefined) {
        if (workspace.persistence !== "ephemeral" && workspace.persistence !== "sticky") {
            invalidSandboxConfig("Sandbox workspace persistence must be ephemeral or sticky.");
        }
        out.persistence = workspace.persistence;
    }
    return out;
}

/**
 * @param {unknown} input
 */
export function normalizeSandboxHandleControls(input) {
    const source = isPlainObject(input) ? input : {};
    return {
        env: normalizeSandboxEnv(source.env),
        ports: normalizeSandboxPorts(source.ports),
        volumes: normalizeSandboxVolumes(source.volumes),
        memoryLimit: normalizeResourceLimit(source.memoryLimit, "memoryLimit", MEMORY_LIMIT_RE),
        cpuLimit: normalizeResourceLimit(source.cpuLimit, "cpuLimit", CPU_LIMIT_RE),
        workspace: normalizeSandboxWorkspace(source.workspace),
    };
}

/**
 * @param {import("../SandboxHandle.ts").SandboxHandle} handle
 * @param {string} runtime
 */
function assertNoLocalOnlyUnsupportedControls(handle, runtime) {
    if (handle.ports?.length) {
        invalidSandboxConfig(`${runtime} sandbox runtime does not support explicit port publishing.`, { runtime });
    }
    if (handle.memoryLimit) {
        invalidSandboxConfig(`${runtime} sandbox runtime does not support memoryLimit.`, { runtime });
    }
    if (handle.cpuLimit) {
        invalidSandboxConfig(`${runtime} sandbox runtime does not support cpuLimit.`, { runtime });
    }
    if (handle.workspace) {
        invalidSandboxConfig(`${runtime} sandbox runtime does not support managed workspace controls.`, { runtime });
    }
}

/**
 * @param {import("../SandboxHandle.ts").SandboxHandle} handle
 * @param {string} runtime
 */
function assertNoVolumes(handle, runtime) {
    if (handle.volumes?.length) {
        invalidSandboxConfig(`${runtime} sandbox runtime does not support volume remapping.`, { runtime });
    }
}

/**
 * @param {string} containerPath
 */
function assertDockerVolumeDoesNotOverrideRuntimeMount(containerPath) {
    if (containerPath === "/workspace" || containerPath.startsWith("/workspace/") ||
        containerPath === "/result" || containerPath.startsWith("/result/")) {
        invalidSandboxConfig("Sandbox volumes may not override /workspace or /result.", {
            container: containerPath,
        });
    }
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string; runtime: string; timeoutMs?: number; maxOutputBytes?: number }} options
 */
export function spawnSandboxCommand(command, args, options) {
    return spawnCaptureEffect(command, args, {
        cwd: options.cwd,
        env: sandboxRunnerEnv(),
        timeoutMs: options.timeoutMs ?? DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS,
        idleTimeoutMs: options.timeoutMs ?? DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS,
        maxOutputBytes: options.maxOutputBytes ?? DEFAULT_SANDBOX_OUTPUT_BYTES,
        detached: true,
    }).pipe(Effect.flatMap((result) => {
        if (result.exitCode === 0) {
            return Effect.succeed({ exitCode: 0 });
        }
        return Effect.fail(new SmithersError("SANDBOX_EXECUTION_FAILED", `${options.runtime} sandbox command exited with code ${result.exitCode}.`, {
            runtime: options.runtime,
            command,
            args,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
        }));
    }));
}

/**
 * @param {string} command
 * @param {import("../SandboxHandle.ts").SandboxHandle} handle
 * @returns {string[]}
 */
export function bubblewrapArgs(command, handle) {
    assertNoLocalOnlyUnsupportedControls(handle, "bubblewrap");
    const sandboxEnv = normalizeSandboxEnv(handle.env, { includeDefaultPath: true });
    const volumes = normalizeSandboxVolumes(handle.volumes);
    const args = [
        "--die-with-parent",
        "--clearenv",
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-cgroup",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--ro-bind",
        handle.requestPath,
        "/workspace",
        "--bind",
        handle.resultPath,
        "/result",
        "--chdir",
        "/workspace",
    ];
    for (const [key, value] of Object.entries(sandboxEnv)) {
        args.push("--setenv", key, value);
    }
    for (const volume of volumes) {
        args.push(volume.readonly === false ? "--bind" : "--ro-bind", volume.host, volume.container);
    }
    if (!handle.allowNetwork) {
        args.push("--unshare-net");
    }
    for (const path of ["/usr", "/bin", "/lib", "/lib64"]) {
        if (existsSync(path)) {
            args.push("--ro-bind", path, path);
        }
    }
    args.push("/bin/sh", "-lc", command);
    return args;
}

/**
 * @param {string} value
 */
function sandboxProfileString(value) {
    return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/**
 * @param {string} command
 * @param {import("../SandboxHandle.ts").SandboxHandle} handle
 * @returns {string[]}
 */
export function sandboxExecArgs(command, handle) {
    assertNoLocalOnlyUnsupportedControls(handle, "sandbox-exec");
    assertNoVolumes(handle, "sandbox-exec");
    const tempPath = join(handle.sandboxRoot, "tmp");
    const sandboxEnv = {
        ...normalizeSandboxEnv(handle.env, { includeDefaultPath: true }),
        HOME: tempPath,
        TMPDIR: tempPath,
    };
    const networkRule = handle.allowNetwork ? "(allow network*)" : "(deny network*)";
    const requestPath = sandboxProfileString(handle.requestPath);
    const resultPath = sandboxProfileString(handle.resultPath);
    const escapedTempPath = sandboxProfileString(tempPath);
    const profile = [
        "(version 1)",
        "(deny default)",
        "(allow process*)",
        networkRule,
        `(allow file-read* (subpath "/bin") (subpath "/usr") (subpath "${requestPath}") (subpath "${resultPath}") (subpath "${escapedTempPath}"))`,
        `(allow file-write* (subpath "${resultPath}") (subpath "${escapedTempPath}") (subpath "/tmp"))`,
    ].join(" ");
    const envArgs = Object.entries(sandboxEnv).map(([key, value]) => `${key}=${value}`);
    return ["-p", profile, "/usr/bin/env", "-i", ...envArgs, "/bin/sh", "-lc", command];
}

/**
 * @param {string} command
 * @param {import("../SandboxHandle.ts").SandboxHandle} handle
 * @returns {string[]}
 */
export function dockerArgs(command, handle) {
    if (handle.workspace) {
        invalidSandboxConfig("docker sandbox runtime does not support managed workspace controls.", { runtime: "docker" });
    }
    const sandboxEnv = normalizeSandboxEnv(handle.env);
    const ports = normalizeSandboxPorts(handle.ports);
    const volumes = normalizeSandboxVolumes(handle.volumes);
    if (!handle.allowNetwork && ports.length > 0) {
        invalidSandboxConfig("Sandbox port publishing requires allowNetwork=true.", { runtime: "docker" });
    }
    const args = [
        "run",
        "--rm",
        "--workdir",
        "/workspace",
        "--volume",
        `${handle.requestPath}:/workspace:ro`,
        "--volume",
        `${handle.resultPath}:/result`,
    ];
    for (const [key, value] of Object.entries(sandboxEnv)) {
        args.push("--env", `${key}=${value}`);
    }
    for (const port of ports) {
        args.push("--publish", `${port.host}:${port.container}`);
    }
    for (const volume of volumes) {
        assertDockerVolumeDoesNotOverrideRuntimeMount(volume.container);
        args.push("--volume", `${volume.host}:${volume.container}:${volume.readonly === false ? "rw" : "ro"}`);
    }
    if (handle.memoryLimit) {
        args.push("--memory", handle.memoryLimit);
    }
    if (handle.cpuLimit) {
        args.push("--cpus", handle.cpuLimit);
    }
    if (!handle.allowNetwork) {
        args.push("--network", "none");
    }
    args.push(handle.image ?? DEFAULT_DOCKER_IMAGE, "/bin/sh", "-lc", command);
    return args;
}

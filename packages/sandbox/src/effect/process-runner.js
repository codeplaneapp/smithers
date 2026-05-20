import { existsSync } from "node:fs";
import { spawnCaptureEffect } from "@smithers-orchestrator/driver/child-process";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { Effect } from "effect";

const DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SANDBOX_OUTPUT_BYTES = 5 * 1024 * 1024;
const DEFAULT_DOCKER_IMAGE = "oven/bun:1";

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string; runtime: string; timeoutMs?: number; maxOutputBytes?: number }} options
 */
export function spawnSandboxCommand(command, args, options) {
    return spawnCaptureEffect(command, args, {
        cwd: options.cwd,
        env: process.env,
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
    const args = [
        "--die-with-parent",
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
        "--bind",
        handle.requestPath,
        "/workspace",
        "--bind",
        handle.resultPath,
        "/result",
        "--chdir",
        "/workspace",
    ];
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
    const networkRule = handle.allowNetwork ? "(allow network*)" : "(deny network*)";
    const requestPath = sandboxProfileString(handle.requestPath);
    const resultPath = sandboxProfileString(handle.resultPath);
    const profile = [
        "(version 1)",
        "(deny default)",
        "(allow process*)",
        networkRule,
        `(allow file-read* (subpath "/bin") (subpath "/usr") (subpath "${requestPath}") (subpath "${resultPath}"))`,
        `(allow file-write* (subpath "${requestPath}") (subpath "${resultPath}") (subpath "/tmp"))`,
    ].join(" ");
    return ["-p", profile, "/bin/sh", "-lc", command];
}

/**
 * @param {string} command
 * @param {import("../SandboxHandle.ts").SandboxHandle} handle
 * @returns {string[]}
 */
export function dockerArgs(command, handle) {
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
    if (!handle.allowNetwork) {
        args.push("--network", "none");
    }
    args.push(handle.image ?? DEFAULT_DOCKER_IMAGE, "/bin/sh", "-lc", command);
    return args;
}

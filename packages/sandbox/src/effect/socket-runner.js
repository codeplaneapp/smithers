import { SocketRunner } from "@effect/cluster";
import { existsSync } from "node:fs";
import { mkdir, cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { spawnCaptureEffect } from "@smithers-orchestrator/driver/child-process";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { SandboxEntityExecutor } from "./sandbox-entity.js";
/** @typedef {import("../SandboxTransportConfig.ts").SandboxTransportConfig} SandboxTransportConfig */
/** @typedef {import("../SandboxHandle.ts").SandboxHandle} SandboxHandle */
/**
 * @param {SandboxTransportConfig} config
 * @returns {SandboxHandle}
 */
function baseHandle(config) {
    const sandboxRoot = join(config.rootDir, ".smithers", "sandboxes", config.runId, config.sandboxId);
    return {
        runtime: config.runtime,
        runId: config.runId,
        sandboxId: config.sandboxId,
        sandboxRoot,
        requestPath: join(sandboxRoot, "request"),
        resultPath: join(sandboxRoot, "result"),
    };
}
const BWRAP_HOST_READ_PATHS = [
    "/bin",
    "/lib",
    "/lib64",
    "/usr",
];
const MACOS_SANDBOX_READ_PATHS = [
    "/bin",
    "/usr",
    "/System",
    "/Library",
];
const SANDBOX_EXEC_TIMEOUT_MS = 10 * 60 * 1000;
const SANDBOX_EXEC_OUTPUT_BYTES = 1_000_000;
const SANDBOX_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin";
const SANDBOX_PROCESS_ENV = {
    HOME: "/tmp",
    PATH: SANDBOX_PATH,
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
};
/**
 * @param {SandboxHandle} handle
 */
function sandboxTempPath(handle) {
    return join(handle.sandboxRoot, "tmp");
}
/**
 * @param {SandboxHandle} handle
 */
function sandboxProcessEnv(handle) {
    if (process.platform !== "darwin") {
        return SANDBOX_PROCESS_ENV;
    }
    const tempPath = sandboxTempPath(handle);
    return {
        ...SANDBOX_PROCESS_ENV,
        HOME: tempPath,
        TMPDIR: tempPath,
    };
}
/**
 * @param {string} value
 */
function sandboxProfileString(value) {
    return JSON.stringify(value);
}
/**
 * @param {string} command
 * @param {SandboxHandle} handle
 */
function bubblewrapArgs(command, handle) {
    const args = [
        "--die-with-parent",
        "--unshare-all",
        "--clearenv",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--dir",
        "/tmp",
        "--dir",
        "/workspace",
        "--dir",
        "/result",
        "--setenv",
        "HOME",
        "/tmp",
        "--setenv",
        "PATH",
        SANDBOX_PATH,
        "--setenv",
        "TMPDIR",
        "/tmp",
    ];
    for (const path of BWRAP_HOST_READ_PATHS) {
        if (existsSync(path)) {
            args.push("--ro-bind-try", path, path);
        }
    }
    args.push("--bind", handle.requestPath, "/workspace", "--bind", handle.resultPath, "/result", "--chdir", "/workspace", "/bin/sh", "-lc", command);
    return args;
}
/**
 * @param {string} command
 * @param {SandboxHandle} handle
 */
function sandboxExecArgs(command, handle) {
    const tempPath = sandboxTempPath(handle);
    const readRules = MACOS_SANDBOX_READ_PATHS
        .filter((path) => existsSync(path))
        .map((path) => `(subpath ${sandboxProfileString(path)})`)
        .join(" ");
    const profile = [
        "(version 1)",
        "(deny default)",
        "(allow process*)",
        `(allow file-read* ${readRules} (subpath ${sandboxProfileString(handle.requestPath)}) (subpath ${sandboxProfileString(handle.resultPath)}) (subpath ${sandboxProfileString(tempPath)}))`,
        `(allow file-write* (subpath ${sandboxProfileString(handle.requestPath)}) (subpath ${sandboxProfileString(handle.resultPath)}) (subpath ${sandboxProfileString(tempPath)}))`,
    ].join("\n");
    return ["-p", profile, "/bin/sh", "-lc", command];
}
/**
 * @param {string} command
 * @param {SandboxHandle} handle
 */
function executeLocalSandbox(command, handle) {
    return Effect.gen(function* () {
        let binary;
        let args;
        if (process.platform === "darwin") {
            binary = typeof Bun !== "undefined" ? Bun.which("sandbox-exec") : null;
            if (!binary) {
                return yield* Effect.fail(new SmithersError("PROCESS_SPAWN_FAILED", "bubblewrap runtime on macOS requires `sandbox-exec` for fallback isolation.", { runtime: "bubblewrap" }));
            }
            args = sandboxExecArgs(command, handle);
        }
        else {
            binary = typeof Bun !== "undefined" ? Bun.which("bwrap") : null;
            if (!binary) {
                return yield* Effect.fail(new SmithersError("PROCESS_SPAWN_FAILED", "Bubblewrap runtime requested but `bwrap` is not installed. Install bubblewrap (package: bubblewrap) or use runtime=\"docker\".", { runtime: "bubblewrap" }));
            }
            args = bubblewrapArgs(command, handle);
        }
        const result = yield* spawnCaptureEffect(binary, args, {
            cwd: handle.requestPath,
            env: sandboxProcessEnv(handle),
            timeoutMs: SANDBOX_EXEC_TIMEOUT_MS,
            maxOutputBytes: SANDBOX_EXEC_OUTPUT_BYTES,
            detached: true,
        });
        if (result.exitCode !== 0) {
            return yield* Effect.fail(new SmithersError("SANDBOX_EXECUTION_FAILED", `Sandbox command exited with code ${result.exitCode ?? "null"}.`, {
                runtime: handle.runtime,
                runId: handle.runId,
                sandboxId: handle.sandboxId,
                command,
                exitCode: result.exitCode,
                stderr: result.stderr,
            }));
        }
        return { exitCode: result.exitCode ?? 0 };
    });
}
/** @type {Layer.Layer<SandboxEntityExecutor, never, never>} */
export const BubblewrapSandboxExecutorLive = Layer.succeed(SandboxEntityExecutor, SandboxEntityExecutor.of({
    create: (config) => Effect.gen(function* () {
        if (process.platform === "linux") {
            const bwrap = typeof Bun !== "undefined" ? Bun.which("bwrap") : null;
            if (!bwrap) {
                yield* Effect.fail(new SmithersError("PROCESS_SPAWN_FAILED", "Bubblewrap runtime requested but `bwrap` is not installed. Install bubblewrap (package: bubblewrap) or use runtime=\"docker\".", { runtime: "bubblewrap" }));
            }
        }
        if (process.platform === "darwin") {
            const sandboxExec = typeof Bun !== "undefined" ? Bun.which("sandbox-exec") : null;
            if (!sandboxExec) {
                yield* Effect.fail(new SmithersError("PROCESS_SPAWN_FAILED", "bubblewrap runtime on macOS requires `sandbox-exec` for fallback isolation.", { runtime: "bubblewrap" }));
            }
        }
        const handle = baseHandle(config);
        yield* Effect.tryPromise({
            try: async () => {
                await mkdir(handle.requestPath, { recursive: true });
                await mkdir(handle.resultPath, { recursive: true });
                await mkdir(sandboxTempPath(handle), { recursive: true });
            },
            catch: (cause) => toSmithersError(cause, "create sandbox workspace"),
        });
        return handle;
    }),
    ship: (bundlePath, handle) => Effect.tryPromise({
        try: async () => {
            await rm(handle.requestPath, { recursive: true, force: true });
            await mkdir(handle.requestPath, { recursive: true });
            await cp(bundlePath, handle.requestPath, { recursive: true });
        },
        catch: (cause) => toSmithersError(cause, "ship sandbox bundle"),
    }),
    execute: (command, handle) => executeLocalSandbox(command, handle),
    collect: (handle) => Effect.succeed({ bundlePath: handle.resultPath }),
    cleanup: (handle) => Effect.tryPromise({
        try: () => rm(handle.sandboxRoot, { recursive: true, force: true }),
        catch: (cause) => toSmithersError(cause, "cleanup sandbox workspace"),
    }),
}));
export const SandboxSocketRunner = SocketRunner;

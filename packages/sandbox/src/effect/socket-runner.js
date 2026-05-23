import { SocketRunner } from "@effect/cluster";
import { mkdir, cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { SandboxEntityExecutor } from "./sandbox-entity.js";
import { bubblewrapArgs, normalizeSandboxHandleControls, sandboxExecArgs, spawnSandboxCommand } from "./process-runner.js";
/** @typedef {import("../SandboxTransportConfig.ts").SandboxTransportConfig} SandboxTransportConfig */
/** @typedef {import("../SandboxHandle.ts").SandboxHandle} SandboxHandle */
/**
 * @param {SandboxTransportConfig} config
 * @returns {SandboxHandle}
 */
function baseHandle(config) {
    const sandboxRoot = join(config.rootDir, ".smithers", "sandboxes", config.runId, config.sandboxId);
    const controls = normalizeSandboxHandleControls(config);
    return {
        runtime: config.runtime,
        runId: config.runId,
        sandboxId: config.sandboxId,
        sandboxRoot,
        requestPath: join(sandboxRoot, "request"),
        resultPath: join(sandboxRoot, "result"),
        image: config.image,
        allowNetwork: Boolean(config.allowNetwork),
        ...controls,
    };
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
                await mkdir(join(handle.sandboxRoot, "tmp"), { recursive: true });
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
    execute: (command, handle) => Effect.gen(function* () {
        if (process.platform === "darwin") {
            const sandboxExec = typeof Bun !== "undefined" ? Bun.which("sandbox-exec") : null;
            if (!sandboxExec) {
                yield* Effect.fail(new SmithersError("PROCESS_SPAWN_FAILED", "bubblewrap runtime on macOS requires `sandbox-exec` for fallback isolation.", { runtime: "bubblewrap" }));
            }
            return yield* spawnSandboxCommand(sandboxExec, sandboxExecArgs(command, handle), {
                cwd: handle.requestPath,
                runtime: "sandbox-exec",
            });
        }
        const bwrap = typeof Bun !== "undefined" ? Bun.which("bwrap") : null;
        if (!bwrap) {
            yield* Effect.fail(new SmithersError("PROCESS_SPAWN_FAILED", "Bubblewrap runtime requested but `bwrap` is not installed. Install bubblewrap (package: bubblewrap) or use runtime=\"docker\".", { runtime: "bubblewrap" }));
        }
        return yield* spawnSandboxCommand(bwrap, bubblewrapArgs(command, handle), {
            cwd: handle.requestPath,
            runtime: "bubblewrap",
        });
    }),
    collect: (handle) => Effect.succeed({ bundlePath: handle.resultPath }),
    cleanup: (handle) => Effect.tryPromise({
        try: async () => {
            await rm(handle.requestPath, { recursive: true, force: true });
            await rm(join(handle.sandboxRoot, "tmp"), { recursive: true, force: true });
        },
        catch: (cause) => toSmithersError(cause, "cleanup sandbox workspace"),
    }),
}));
export const SandboxSocketRunner = SocketRunner;

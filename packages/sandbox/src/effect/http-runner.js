import { HttpRunner } from "@effect/cluster";
import { mkdir, cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { spawnCaptureEffect } from "@smithers-orchestrator/driver/child-process";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { SandboxEntityExecutor } from "./sandbox-entity.js";
import { dockerArgs, normalizeSandboxHandleControls, sandboxRunnerEnv, spawnSandboxCommand } from "./process-runner.js";
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
export const DockerSandboxExecutorLive = Layer.succeed(SandboxEntityExecutor, SandboxEntityExecutor.of({
    create: (config) => Effect.gen(function* () {
        const handle = baseHandle(config);
        yield* spawnCaptureEffect("docker", ["info"], {
            cwd: config.rootDir,
            env: sandboxRunnerEnv(),
            timeoutMs: 10_000,
            maxOutputBytes: 200_000,
        }).pipe(Effect.catchAll(() => Effect.fail(new SmithersError("PROCESS_SPAWN_FAILED", "Docker daemon not reachable.", { runtime: "docker" }))));
        yield* Effect.tryPromise({
            try: async () => {
                await mkdir(handle.requestPath, { recursive: true });
                await mkdir(handle.resultPath, { recursive: true });
            },
            catch: (cause) => toSmithersError(cause, "create docker sandbox workspace"),
        });
        return handle;
    }),
    ship: (bundlePath, handle) => Effect.tryPromise({
        try: async () => {
            await rm(handle.requestPath, { recursive: true, force: true });
            await mkdir(handle.requestPath, { recursive: true });
            await cp(bundlePath, handle.requestPath, { recursive: true });
        },
        catch: (cause) => toSmithersError(cause, "ship docker bundle"),
    }),
    execute: (command, handle) => spawnSandboxCommand("docker", dockerArgs(command, handle), {
        cwd: handle.requestPath,
        runtime: "docker",
    }),
    collect: (handle) => Effect.succeed({ bundlePath: handle.resultPath }),
    cleanup: (handle) => Effect.tryPromise({
        try: () => rm(handle.requestPath, { recursive: true, force: true }),
        catch: (cause) => toSmithersError(cause, "cleanup docker sandbox workspace"),
    }),
}));
/** @type {Layer.Layer<SandboxEntityExecutor, never, never>} */
export const CodeplaneSandboxExecutorLive = Layer.succeed(SandboxEntityExecutor, SandboxEntityExecutor.of({
    create: (config) => Effect.gen(function* () {
        const apiUrl = process.env.CODEPLANE_API_URL;
        const apiKey = process.env.CODEPLANE_API_KEY;
        if (!apiUrl || !apiKey) {
            yield* Effect.fail(new SmithersError("INVALID_INPUT", "Codeplane runtime requires CODEPLANE_API_URL and CODEPLANE_API_KEY."));
        }
        const handle = baseHandle(config);
        yield* Effect.tryPromise({
            try: async () => {
                await mkdir(handle.requestPath, { recursive: true });
                await mkdir(handle.resultPath, { recursive: true });
            },
            catch: (cause) => toSmithersError(cause, "create codeplane sandbox workspace"),
        });
        return {
            ...handle,
            workspaceId: `${config.runId}:${config.sandboxId}`,
        };
    }),
    ship: (bundlePath, handle) => Effect.tryPromise({
        try: async () => {
            await rm(handle.requestPath, { recursive: true, force: true });
            await mkdir(handle.requestPath, { recursive: true });
            await cp(bundlePath, handle.requestPath, { recursive: true });
        },
        catch: (cause) => toSmithersError(cause, "ship codeplane bundle"),
    }),
    execute: (command, handle) => Effect.fail(new SmithersError("SANDBOX_EXECUTION_FAILED", "Codeplane sandbox command execution requires the remote Codeplane worker integration.", {
        runtime: "codeplane",
        command,
        workspaceId: handle.workspaceId ?? null,
    })),
    collect: (handle) => Effect.succeed({ bundlePath: handle.resultPath }),
    cleanup: (handle) => Effect.tryPromise({
        try: () => rm(handle.requestPath, { recursive: true, force: true }),
        catch: (cause) => toSmithersError(cause, "cleanup codeplane sandbox workspace"),
    }),
}));
export const SandboxHttpRunner = HttpRunner;

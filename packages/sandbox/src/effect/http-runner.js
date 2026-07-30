import { HttpRunner } from "effect/unstable/cluster";
import { mkdir, cp, rm } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { spawnCaptureEffect } from "@smithers-orchestrator/driver/child-process";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { SandboxEntityExecutor } from "./sandbox-entity.js";
import { dockerArgs, makeBaseSandboxHandle, sandboxRunnerEnv, spawnSandboxCommand } from "./process-runner.js";
/** @type {Layer.Layer<SandboxEntityExecutor, never, never>} */
export const DockerSandboxExecutorLive = Layer.succeed(
  SandboxEntityExecutor,
  SandboxEntityExecutor.of({
    create: (config) =>
      Effect.gen(function* () {
        const handle = makeBaseSandboxHandle(config);
        yield* spawnCaptureEffect("docker", ["info"], {
          cwd: config.rootDir,
          env: sandboxRunnerEnv(),
          timeoutMs: 10_000,
          maxOutputBytes: 200_000,
        }).pipe(
          Effect.catch(() =>
            Effect.fail(
              new SmithersError("PROCESS_SPAWN_FAILED", "Docker daemon not reachable.", { runtime: "docker" }),
            ),
          ),
        );
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(handle.requestPath, { recursive: true });
            await mkdir(handle.resultPath, { recursive: true });
          },
          catch: (cause) => toSmithersError(cause, "create docker sandbox workspace"),
        });
        return handle;
      }),
    ship: (bundlePath, handle) =>
      Effect.tryPromise({
        try: async () => {
          await rm(handle.requestPath, { recursive: true, force: true });
          await mkdir(handle.requestPath, { recursive: true });
          await cp(bundlePath, handle.requestPath, { recursive: true });
        },
        catch: (cause) => toSmithersError(cause, "ship docker bundle"),
      }),
    execute: (command, handle, signal) =>
      spawnSandboxCommand("docker", dockerArgs(command, handle), {
        cwd: handle.requestPath,
        runtime: "docker",
        // Kills the docker CLI client's process group on cancel. NOTE: a
        // `docker run --rm` daemon-side container can still outlive the client;
        // fully tearing that down needs --cidfile + `docker rm -f` in cleanup
        // (tracked separately).
        signal,
      }),
    collect: (handle) => Effect.succeed({ bundlePath: handle.resultPath }),
    cleanup: (handle) =>
      Effect.tryPromise({
        try: () => rm(handle.requestPath, { recursive: true, force: true }),
        catch: (cause) => toSmithersError(cause, "cleanup docker sandbox workspace"),
      }),
  }),
);
/** @type {Layer.Layer<SandboxEntityExecutor, never, never>} */
export const CodeplaneSandboxExecutorLive = Layer.succeed(
  SandboxEntityExecutor,
  SandboxEntityExecutor.of({
    create: (config) =>
      Effect.gen(function* () {
        const apiUrl = process.env.CODEPLANE_API_URL;
        const apiKey = process.env.CODEPLANE_API_KEY;
        if (!apiUrl || !apiKey) {
          yield* Effect.fail(
            new SmithersError("INVALID_INPUT", "Codeplane runtime requires CODEPLANE_API_URL and CODEPLANE_API_KEY."),
          );
        }
        const handle = makeBaseSandboxHandle(config);
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
    ship: (bundlePath, handle) =>
      Effect.tryPromise({
        try: async () => {
          await rm(handle.requestPath, { recursive: true, force: true });
          await mkdir(handle.requestPath, { recursive: true });
          await cp(bundlePath, handle.requestPath, { recursive: true });
        },
        catch: (cause) => toSmithersError(cause, "ship codeplane bundle"),
      }),
    execute: (command, handle) =>
      Effect.fail(
        new SmithersError(
          "SANDBOX_EXECUTION_FAILED",
          "Codeplane sandbox command execution requires the remote Codeplane worker integration.",
          {
            runtime: "codeplane",
            command,
            workspaceId: handle.workspaceId ?? null,
          },
        ),
      ),
    collect: (handle) => Effect.succeed({ bundlePath: handle.resultPath }),
    cleanup: (handle) =>
      Effect.tryPromise({
        try: () => rm(handle.requestPath, { recursive: true, force: true }),
        catch: (cause) => toSmithersError(cause, "cleanup codeplane sandbox workspace"),
      }),
  }),
);
export const SandboxHttpRunner = HttpRunner;

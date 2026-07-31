import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer } from "effect";
import { SandboxEntityExecutor } from "../src/effect/sandbox-entity.js";
import { SandboxTransport, makeSandboxTransportLayer } from "../src/transport.js";
const config = {
  runId: "run-entity-contract",
  sandboxId: "sb-1",
  runtime: "bubblewrap",
  rootDir: "/tmp/smithers",
};
const handle = {
  runtime: "bubblewrap",
  runId: config.runId,
  sandboxId: config.sandboxId,
  sandboxRoot: "/tmp/smithers/.smithers/sandboxes/run-entity-contract/sb-1",
  requestPath: "/tmp/smithers/.smithers/sandboxes/run-entity-contract/sb-1/request",
  resultPath: "/tmp/smithers/.smithers/sandboxes/run-entity-contract/sb-1/result",
};
describe("sandbox entity contract", () => {
  test("exposes constructable service tag classes", () => {
    expect(new SandboxEntityExecutor()).toBeInstanceOf(SandboxEntityExecutor);
    expect(new SandboxTransport()).toBeInstanceOf(SandboxTransport);
  });

  test("preserves the sandbox transport contract through entity dispatch", async () => {
    const calls = [];
    const executorLayer = Layer.succeed(
      SandboxEntityExecutor,
      SandboxEntityExecutor.of({
        create: (input) =>
          Effect.sync(() => {
            calls.push({ op: "create", runtime: input.runtime, sandboxId: input.sandboxId });
            return handle;
          }),
        ship: (bundlePath, currentHandle) =>
          Effect.sync(() => {
            calls.push({
              op: "ship",
              bundlePath,
              sandboxId: currentHandle.sandboxId,
            });
          }),
        execute: (command, currentHandle) =>
          Effect.sync(() => {
            calls.push({
              op: "execute",
              command,
              sandboxId: currentHandle.sandboxId,
            });
            return { exitCode: 0 };
          }),
        collect: (currentHandle) =>
          Effect.sync(() => {
            calls.push({
              op: "collect",
              sandboxId: currentHandle.sandboxId,
            });
            return { bundlePath: currentHandle.resultPath };
          }),
        cleanup: (currentHandle) =>
          Effect.sync(() => {
            calls.push({
              op: "cleanup",
              sandboxId: currentHandle.sandboxId,
            });
          }),
      }),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* SandboxTransport;
        const created = yield* transport.create(config);
        yield* transport.ship("/tmp/request-bundle", created);
        const executed = yield* transport.execute("smithers up bundle.tsx", created);
        const collected = yield* transport.collect(created);
        yield* transport.cleanup(created);
        return { created, executed, collected };
      }).pipe(Effect.provide(makeSandboxTransportLayer(executorLayer))),
    );
    expect(result.created).toEqual(handle);
    expect(result.executed).toEqual({ exitCode: 0 });
    expect(result.collected).toEqual({ bundlePath: handle.resultPath });
    expect(calls).toEqual([
      {
        op: "create",
        runtime: "bubblewrap",
        sandboxId: "sb-1",
      },
      {
        op: "ship",
        bundlePath: "/tmp/request-bundle",
        sandboxId: "sb-1",
      },
      {
        op: "execute",
        command: "smithers up bundle.tsx",
        sandboxId: "sb-1",
      },
      {
        op: "collect",
        sandboxId: "sb-1",
      },
      {
        op: "cleanup",
        sandboxId: "sb-1",
      },
    ]);
  });

  test("propagates a caller abort signal through the entity boundary to the executor", async () => {
    const { promise: signalReceived, resolve: resolveSignal } = Promise.withResolvers();
    const executorLayer = Layer.succeed(
      SandboxEntityExecutor,
      SandboxEntityExecutor.of({
        create: () => Effect.succeed(handle),
        ship: () => Effect.void,
        execute: (_command, _currentHandle, signal) =>
          Effect.callback(() => {
            resolveSignal(signal);
            // never resumes on its own; only the abort should end the call
          }),
        collect: (currentHandle) => Effect.succeed({ bundlePath: currentHandle.resultPath }),
        cleanup: () => Effect.void,
      }),
    );
    const controller = new AbortController();
    const program = Effect.gen(function* () {
      const transport = yield* SandboxTransport;
      const created = yield* transport.create(config);
      yield* transport.execute("smithers up bundle.tsx", created, controller.signal);
    }).pipe(Effect.provide(makeSandboxTransportLayer(executorLayer)));
    const exitPromise = Effect.runPromiseExit(program);
    const executorSignal = await signalReceived;
    expect(executorSignal).toBeInstanceOf(AbortSignal);
    expect(executorSignal.aborted).toBe(false);
    controller.abort();
    const exit = await exitPromise;
    expect(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)).toBe(true);
    expect(executorSignal.aborted).toBe(true);
  });

  test("wraps executor failures with sandbox entity context", async () => {
    const executorLayer = Layer.succeed(
      SandboxEntityExecutor,
      SandboxEntityExecutor.of({
        create: () => Effect.fail(new Error("create exploded")),
        ship: () => Effect.void,
        execute: () => Effect.succeed({ exitCode: 0 }),
        collect: (currentHandle) => Effect.succeed({ bundlePath: currentHandle.resultPath }),
        cleanup: () => Effect.void,
      }),
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const transport = yield* SandboxTransport;
          yield* transport.create(config);
        }).pipe(Effect.provide(makeSandboxTransportLayer(executorLayer))),
      ),
    ).rejects.toThrow("sandbox entity create failed: create exploded");
  });
});

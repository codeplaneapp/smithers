/** @jsxImportSource smthrs */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Task, Workflow, runWorkflow } from "smthrs";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";
import { sleep } from "../src/sleep.js";

/** @type {ReturnType<typeof spyOn> | undefined} */
let setTimeoutSpy;
afterEach(() => {
  setTimeoutSpy?.mockRestore();
  setTimeoutSpy = undefined;
});

function buildSmithers() {
  return createTestSmithers(outputSchemas);
}
describe("Engine regressions", () => {
  test("sleep chunks delays above the safe single-timer maximum without shortening them", async () => {
    const maxTimerDelayMs = 2_147_483_647;
    const callbacks = [];
    const delays = [];
    setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      /** @type {any} */ (
        (callback, delayMs) => {
          callbacks.push(callback);
          delays.push(delayMs);
          return { delayMs };
        }
      ),
    );

    const sleeping = sleep(maxTimerDelayMs + 5_000);
    expect(delays).toEqual([maxTimerDelayMs]);
    callbacks.shift()();
    expect(delays).toEqual([maxTimerDelayMs, 5_000]);
    callbacks.shift()();
    await sleeping;
  });

  test("explicitly retryable configuration failures reach a second agent attempt", async () => {
    const { smithers, outputs, cleanup } = buildSmithers();
    try {
      let calls = 0;
      const retryableConfigAgent = {
        id: "retryable-config",
        tools: {},
        supportsNativeStructuredOutput: true,
        generate: async () => {
          calls += 1;
          if (calls === 1) {
            throw new SmithersError("AGENT_CONFIG_INVALID", "temporary managed-auth refresh conflict", {
              failureRetryable: true,
              retryAfterMs: 0,
            });
          }
          return { output: { value: 7 } };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="retryable-config-override">
          <Task
            id="task"
            output={outputs.outputA}
            retries={1}
            retryPolicy={{ backoff: "fixed", initialDelayMs: 0 }}
            agent={retryableConfigAgent}
          >
            run task
          </Task>
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");
      expect(calls).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("fallbackAgent is used only on retry attempts", async () => {
    const { smithers, outputs, cleanup } = buildSmithers();
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primaryAgent = {
      id: "primary",
      tools: {},
      generate: async () => {
        primaryCalls += 1;
        throw new Error("primary failed");
      },
    };
    const fallbackAgent = {
      id: "fallback",
      tools: {},
      generate: async () => {
        fallbackCalls += 1;
        return { output: { value: 7 } };
      },
    };
    const workflow = smithers((_ctx) => (
      <Workflow name="fallback-retry">
        <Task id="task" output={outputs.outputA} retries={1} agent={primaryAgent} fallbackAgent={fallbackAgent}>
          run task
        </Task>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(1);
    cleanup();
  });
  test("cancellation completes after an abort-aware process adapter settles", async () => {
    const { smithers, outputs, cleanup } = buildSmithers();
    let signalStarted = () => {};
    const started = new Promise((resolve) => {
      signalStarted = resolve;
    });
    let adapterSettled = false;
    const processLifecycle = [];
    const slowAbortableAgent = {
      id: "slow-abortable",
      tools: {},
      generate: async (args) => {
        processLifecycle.push("started");
        args.onProcess?.({ phase: "started", pid: process.pid });
        signalStarted();
        await new Promise((_, reject) => {
          const abort = () => {
            processLifecycle.push("abort-forwarded");
            setTimeout(() => {
              args.onProcess?.({ phase: "exited", pid: process.pid });
              processLifecycle.push("exited");
              adapterSettled = true;
              const err = new Error("aborted after process cleanup");
              err.name = "AbortError";
              reject(err);
            }, 75);
          };
          if (args.abortSignal?.aborted) {
            abort();
            return;
          }
          args.abortSignal?.addEventListener("abort", abort, { once: true });
        });
      },
    };
    const workflow = smithers((_ctx) => (
      <Workflow name="cancel-in-flight">
        <Task id="slow" output={outputs.outputA} agent={slowAbortableAgent}>
          run slow task
        </Task>
      </Workflow>
    ));
    const controller = new AbortController();
    const startedAt = Date.now();
    const runPromise = Effect.runPromise(
      runWorkflow(workflow, {
        input: {},
        signal: controller.signal,
      }),
    );
    await started;
    const abortedAtMs = Date.now();
    controller.abort();
    const result = await runPromise;
    const cancellationElapsedMs = Date.now() - abortedAtMs;
    expect(result.status).toBe("cancelled");
    expect(adapterSettled).toBe(true);
    expect(processLifecycle).toEqual(["started", "abort-forwarded", "exited"]);
    expect(cancellationElapsedMs).toBeGreaterThanOrEqual(60);
    expect(Date.now() - startedAt).toBeLessThan(1200);
    cleanup();
  });

  test("cancellation preserves a final process checkpoint during cleanup and fences later writes", async () => {
    const { smithers, outputs, db, cleanup } = buildSmithers();
    const adapter = new SmithersDb(db);
    const codec = "test.abort-cleanup";
    const checkpoint = (value) => ({ codec, version: 1, payload: { value } });
    let signalStarted = () => {};
    const started = new Promise((resolve) => {
      signalStarted = resolve;
    });
    let checkpointPublisher;
    const processAgent = {
      id: "abort-cleanup-checkpoint",
      checkpointFormats: [{ codec, versions: [1] }],
      checkpointCapabilities: [{ codec, versions: [1], modes: ["resume"] }],
      async generate(args) {
        checkpointPublisher = args.onCheckpoint;
        args.onProcess?.({ phase: "started", pid: process.pid });
        signalStarted();
        await new Promise((_, reject) => {
          const abort = () => {
            setTimeout(async () => {
              try {
                args.onProcess?.({ phase: "exited", pid: process.pid });
                await Bun.sleep(25);
                await args.onCheckpoint?.(checkpoint("final"));
                const error = new Error("aborted after final checkpoint");
                error.name = "AbortError";
                reject(error);
              } catch (error) {
                reject(error);
              }
            }, 50);
          };
          if (args.abortSignal?.aborted) abort();
          else args.abortSignal?.addEventListener("abort", abort, { once: true });
        });
      },
    };
    const workflow = smithers(() => (
      <Workflow name="abort-cleanup-checkpoint">
        <Task id="work" output={outputs.outputA} agent={processAgent}>
          run task
        </Task>
      </Workflow>
    ));
    const controller = new AbortController();

    try {
      const runPromise = Effect.runPromise(runWorkflow(workflow, { input: {}, signal: controller.signal }));
      await started;
      controller.abort();
      const result = await runPromise;
      expect(result.status).toBe("cancelled");

      const refs = await adapter.listAgentCheckpointRefs(result.runId, { nodeId: "work" });
      expect(refs.map((ref) => ref.purpose)).toEqual(["progress"]);
      const stored = await adapter.getAgentCheckpoint(refs[0].contentHash);
      expect(JSON.parse(stored.checkpointJson)).toEqual(checkpoint("final"));

      await expect(checkpointPublisher(checkpoint("late"))).rejects.toThrow(/checkpoint ownership was lost/i);
      expect(await adapter.listAgentCheckpointRefs(result.runId, { nodeId: "work" })).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("cancellation interrupts retry backoff without starting another attempt", async () => {
    const { smithers, outputs, db, cleanup } = buildSmithers();
    const runId = "abort-retry-backoff";
    let calls = 0;
    const agent = {
      id: "abort-retry-backoff",
      async generate() {
        calls += 1;
        throw new Error("retry later");
      },
    };
    const workflow = smithers(() => (
      <Workflow name="abort-retry-backoff">
        <Task
          id="work"
          output={outputs.outputA}
          agent={agent}
          retries={1}
          retryPolicy={{ backoff: "fixed", initialDelayMs: 60_000 }}
        >
          run task
        </Task>
      </Workflow>
    ));
    const controller = new AbortController();

    try {
      const runPromise = Effect.runPromise(runWorkflow(workflow, { input: {}, runId, signal: controller.signal }));
      const deadline = Date.now() + 2_000;
      while (
        !db.$client
          .query("SELECT 1 FROM _smithers_events WHERE run_id = ? AND type = 'NodeRetrying' LIMIT 1")
          .get(runId) &&
        Date.now() < deadline
      ) {
        await Bun.sleep(5);
      }
      expect(
        db.$client
          .query("SELECT 1 FROM _smithers_events WHERE run_id = ? AND type = 'NodeRetrying' LIMIT 1")
          .get(runId),
      ).toBeDefined();
      await Bun.sleep(25);

      const abortedAtMs = Date.now();
      controller.abort();
      const result = await runPromise;
      expect(result.status).toBe("cancelled");
      expect(Date.now() - abortedAtMs).toBeLessThan(1_000);
      expect(calls).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("cancellation remains bounded for a non-cooperative agent", async () => {
    const { smithers, outputs, cleanup } = buildSmithers();
    try {
      let signalStarted = () => {};
      const started = new Promise((resolve) => {
        signalStarted = resolve;
      });
      const nonCooperativeAgent = {
        id: "non-cooperative",
        tools: {},
        generate: async () => {
          signalStarted();
          await new Promise(() => {});
        },
      };
      const workflow = smithers(() => (
        <Workflow name="cancel-non-cooperative">
          <Task id="stuck" output={outputs.outputA} agent={nonCooperativeAgent}>
            run stuck task
          </Task>
        </Workflow>
      ));
      const controller = new AbortController();
      const runPromise = Effect.runPromise(runWorkflow(workflow, { input: {}, signal: controller.signal }));
      await started;
      const abortedAtMs = Date.now();
      controller.abort();

      const result = await runPromise;
      const cancellationElapsedMs = Date.now() - abortedAtMs;
      expect(result.status).toBe("cancelled");
      expect(cancellationElapsedMs).toBeLessThan(1_000);
    } finally {
      cleanup();
    }
  });
});

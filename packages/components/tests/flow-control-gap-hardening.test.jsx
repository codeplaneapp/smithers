/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import React from "react";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler/dom/renderer";
import { SmithersContext, SmithersCtx } from "@smithers-orchestrator/react-reconciler/context";
import { Poller, Subflow, Task, Timer, TryCatchFinally, WaitForEvent } from "../src/components/index.js";

async function render(element) {
  const renderer = new SmithersRenderer();
  return renderer.render(element);
}

function ctxFor({ iteration = 0, iterations, outputs = {} } = {}) {
  return new SmithersCtx({
    runId: "flow-control-gaps",
    iteration,
    iterations,
    input: {},
    outputs,
  });
}

describe("TryCatchFinally error-code filter surface", () => {
  test("catchErrors is forwarded verbatim on the host element", () => {
    // The scheduler does not consume __tcfCatchErrors yet (catch mounts on
    // any try failure); this pins the component-level wiring the fix will
    // build on.
    const tcf = TryCatchFinally({
      id: "guard",
      catchErrors: ["TASK_TIMEOUT", "AGENT_QUOTA_EXCEEDED"],
      try: (
        <Task id="risky" output="out">
          {{ ok: true }}
        </Task>
      ),
      catch: (
        <Task id="recover" output="out">
          {{ recovered: true }}
        </Task>
      ),
    });
    expect(tcf.type).toBe("smithers:try-catch-finally");
    expect(tcf.props.__tcfCatchErrors).toEqual(["TASK_TIMEOUT", "AGENT_QUOTA_EXCEEDED"]);

    const unfiltered = TryCatchFinally({
      id: "any",
      try: (
        <Task id="risky" output="out">
          {{ ok: true }}
        </Task>
      ),
    });
    expect(unfiltered.props.__tcfCatchErrors).toBeUndefined();
  });

  test("try tasks are forced to continueOnFail; catch and finally tasks are not", async () => {
    const graph = await render(
      <TryCatchFinally
        id="guard"
        try={
          <Task id="risky" output="try_out">
            {{ ok: true }}
          </Task>
        }
        catch={
          <Task id="recover" output="catch_out">
            {{ recovered: true }}
          </Task>
        }
        finally={
          <Task id="cleanup" output="finally_out">
            {{ done: true }}
          </Task>
        }
      />,
    );
    const byId = new Map(graph.tasks.map((task) => [task.nodeId, task]));
    expect(byId.get("risky")?.continueOnFail).toBe(true);
    expect(byId.get("recover")?.continueOnFail).toBe(false);
    expect(byId.get("cleanup")?.continueOnFail).toBe(false);
  });
});

describe("Subflow mode and input forwarding", () => {
  test("inline mode and input are mirrored into the engine-facing props", () => {
    const sf = Subflow({
      id: "child",
      workflow: "./child.tsx",
      input: { x: 1 },
      mode: "inline",
      output: "child_out",
    });
    expect(sf.props.mode).toBe("inline");
    expect(sf.props.__smithersSubflowMode).toBe("inline");
    expect(sf.props.__smithersSubflowWorkflow).toBe("./child.tsx");
    expect(sf.props.__smithersSubflowInput).toEqual({ x: 1 });
    expect(sf.props.input).toEqual({ x: 1 });
  });
});

describe("Poller defaults and backoff boundaries", () => {
  test("defaults: poll id prefix, 30 attempts, 5s fixed interval, onTimeout=fail", async () => {
    const graph = await render(<Poller check={() => ({ satisfied: false })} checkOutput="check_out" />);
    // The first attempt polls immediately, so iteration 0 has no delay timer,
    // and `intervalMs` no longer leaks into the check's timeout.
    expect(graph.tasks).toHaveLength(1);
    expect(graph.tasks[0].nodeId).toBe("poll-check");
    expect(graph.tasks[0].timeoutMs).toBeNull();
    expect(graph.xml.props).toMatchObject({
      id: "poll-loop",
      maxIterations: "30",
      onMaxReached: "fail",
    });
  });

  test("an unknown backoff strategy falls back to the fixed interval", async () => {
    const graph = await render(
      <SmithersContext.Provider value={ctxFor({ iteration: 3, iterations: { "deploy-loop": 3 } })}>
        <Poller
          id="deploy"
          check={() => ({ satisfied: false })}
          checkOutput="check_out"
          backoff="every-other-tuesday"
          intervalMs={100}
        />
      </SmithersContext.Provider>,
    );
    const delay = graph.tasks.find((task) => task.nodeId === "deploy-delay");
    expect(delay.meta.__timerDuration).toBe("100ms");
  });

  test("exponential backoff grows unclamped from the loop iteration", async () => {
    // 100ms * 2^9 for the 10th gap — there is no upper clamp today, so a
    // long-running exponential poller stretches the poll interval geometrically.
    const graph = await render(
      <SmithersContext.Provider value={ctxFor({ iteration: 10, iterations: { "deploy-loop": 10 } })}>
        <Poller
          id="deploy"
          check={() => ({ satisfied: false })}
          checkOutput="check_out"
          backoff="exponential"
          intervalMs={100}
        />
      </SmithersContext.Provider>,
    );
    const delay = graph.tasks.find((task) => task.nodeId === "deploy-delay");
    expect(delay.meta.__timerDuration).toBe("51200ms");
  });
});

describe("Timer input validation boundaries", () => {
  test("providing both duration and until is rejected", () => {
    expect(() => Timer({ id: "both", duration: "5m", until: "2027-01-01T00:00:00Z" })).toThrow("requires exactly one");
  });

  test("a whitespace-only duration counts as absent", () => {
    expect(() => Timer({ id: "blank", duration: "   " })).toThrow("requires exactly one");
  });
});

describe("WaitForEvent defaults", () => {
  test("a minimal wait defaults to onTimeout=fail, sync wait, and a wait: label", async () => {
    const graph = await render(<WaitForEvent id="wait-min" event="ready" output="wait_out" />);
    const task = graph.tasks[0];
    expect(task.nodeId).toBe("wait-min");
    expect(task.waitAsync).toBe(false);
    expect(task.label).toBe("wait:ready");
    expect(task.meta).toMatchObject({
      __waitForEvent: true,
      __eventName: "ready",
      __onTimeout: "fail",
    });
    expect(task.meta.__correlationId).toBeUndefined();
  });
});

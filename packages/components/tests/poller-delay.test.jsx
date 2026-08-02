/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { SmithersRenderer } from "@smthrs/react-reconciler/dom/renderer";
import { SmithersContext, SmithersCtx } from "@smthrs/react-reconciler/context";
import { Poller } from "../src/components/index.js";

async function render(element) {
  const renderer = new SmithersRenderer();
  return renderer.render(element);
}

function ctxFor({ iteration = 0, iterations, outputs = {} } = {}) {
  return new SmithersCtx({
    runId: "poller-delay-unit",
    iteration,
    iterations,
    input: {},
    outputs,
  });
}

/** Render a <Poller> at a given loop iteration and return its graph. */
function renderPollerAt(iteration, props = {}) {
  return render(
    <SmithersContext.Provider value={ctxFor({ iteration, iterations: { "deploy-loop": iteration } })}>
      <Poller
        id="deploy"
        check={() => ({ satisfied: false })}
        checkOutput="check_out"
        intervalMs={100}
        maxAttempts={7}
        onTimeout="return-last"
        {...props}
      />
    </SmithersContext.Provider>,
  );
}

/** @param {any} graph @param {string} nodeId */
function nodeById(graph, nodeId) {
  return graph.tasks.find((task) => task.nodeId === nodeId);
}

describe("Poller inter-attempt delay", () => {
  test("emits a durable delay Timer before the check on attempts after the first", async () => {
    const graph = await renderPollerAt(1, { backoff: "fixed" });

    const delay = nodeById(graph, "deploy-delay");
    const check = nodeById(graph, "deploy-check");

    expect(delay).toBeDefined();
    expect(delay.meta.__timer).toBe(true);
    expect(delay.meta.__timerDuration).toBe("100ms");
    expect(check).toBeDefined();
    // The Timer must precede the check so <Sequence> gates it.
    expect(graph.tasks.indexOf(delay)).toBeLessThan(graph.tasks.indexOf(check));
  });

  test("does not delay before the first attempt", async () => {
    const graph = await renderPollerAt(0, { backoff: "fixed" });

    expect(graph.tasks.filter((task) => task.meta?.__timer)).toHaveLength(0);
    expect(graph.tasks).toHaveLength(1);
    expect(graph.tasks[0].nodeId).toBe("deploy-check");
  });

  test("backoff scales the inter-attempt delay, not the check timeout", async () => {
    const graph = await renderPollerAt(3, { backoff: "exponential" });

    // gap index 2 -> 100 * 2^2
    expect(nodeById(graph, "deploy-delay").meta.__timerDuration).toBe("400ms");
    // `null` is how the graph spells "no timeout" (extract.js normalizes it).
    expect(nodeById(graph, "deploy-check").timeoutMs).toBeNull();
  });

  test("linear backoff scales the gap by the gap index", async () => {
    const graph = await renderPollerAt(2, { backoff: "linear" });

    // gap index 1 -> 100 * (1 + 1)
    expect(nodeById(graph, "deploy-delay").meta.__timerDuration).toBe("200ms");
  });

  test("checkTimeoutMs bounds a single check attempt, independent of the interval", async () => {
    const graph = await renderPollerAt(1, { backoff: "fixed", checkTimeoutMs: 7000 });

    expect(nodeById(graph, "deploy-check").timeoutMs).toBe(7000);
    expect(nodeById(graph, "deploy-delay").meta.__timerDuration).toBe("100ms");
  });
});

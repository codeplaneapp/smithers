/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { extractGraph } from "../src/extract.js";
import { __setRuntimeModuleLoader, extractFromHost } from "../src/dom/extract.js";
import { buildClaudeWorkflowPhasePlan } from "../src/buildClaudeWorkflowPhasePlan.js";

/**
 * @param {string} tag
 * @param {Record<string, any>} [rawProps]
 * @param {any[]} [children]
 */
function hostEl(tag, rawProps = {}, children = []) {
  const stringProps = {};
  for (const [k, v] of Object.entries(rawProps)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      stringProps[k] = String(v);
    }
  }
  return { kind: "element", tag, props: stringProps, rawProps, children };
}

// A value that satisfies `typeof x === "object"` and is truthy (so it passes the
// output-present guard) but makes drizzle's getTableName throw on its internal
// symbol lookup — exercising the isDrizzleTable try/catch fallback.
function throwingOutput() {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("boom");
      },
    },
  );
}

describe("isDrizzleTable getTableName throw is swallowed", () => {
  test("extractGraph treats a getTableName-throwing output as a non-table", () => {
    const root = hostEl("smithers:workflow", {}, [
      hostEl("smithers:task", {
        id: "t1",
        output: throwingOutput(),
        __smithersKind: "static",
      }),
    ]);
    const result = extractGraph(root);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].outputTable).toBeNull();
    expect(result.tasks[0].outputTableName).toBe("");
  });

  test("extractFromHost treats a getTableName-throwing output as a non-table", () => {
    const root = hostEl("smithers:workflow", {}, [
      hostEl("smithers:task", {
        id: "t1",
        output: throwingOutput(),
        __smithersKind: "static",
      }),
    ]);
    const result = extractFromHost(root);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].outputTable).toBeNull();
    expect(result.tasks[0].outputTableName).toBe("");
  });
});

describe("buildClaudeWorkflowPhasePlan unassigned-task fallback", () => {
  test("a task with no matching xml element lands in the fallback phase", () => {
    const plan = buildClaudeWorkflowPhasePlan(null, [{ nodeId: "orphan", label: "Orphan", ordinal: 0, kind: "agent" }]);
    expect(plan.phases).toEqual([{ title: "Workflow" }]);
    expect(plan.nodes).toEqual([{ nodeId: "orphan", label: "Orphan", phase: "Workflow", kind: "agent" }]);
  });

  test("matches a loop-scoped task nodeId to a bare element id via startsWith", () => {
    const xml = {
      kind: "element",
      tag: "smithers:workflow",
      props: {},
      children: [
        {
          kind: "element",
          tag: "smithers:sequence",
          props: { label: "Phase A" },
          children: [
            { kind: "element", tag: "smithers:task", props: { id: "loop-task" }, children: [] },
            { kind: "element", tag: "smithers:task", props: { id: "plain" }, children: [] },
            // A task element with no id: findTaskForElement bails out early.
            { kind: "element", tag: "smithers:task", props: {}, children: [] },
          ],
        },
      ],
    };
    // Two tasks (exercises the ordinal sort comparator); the first has a
    // loop-scoped nodeId whose bare element id resolves via the startsWith
    // fallback in findTaskForElement.
    const plan = buildClaudeWorkflowPhasePlan(xml, [
      { nodeId: "loop-task@@r=0", label: "Loop", ordinal: 1, kind: "agent" },
      { nodeId: "plain", label: "Plain", ordinal: 0, kind: "compute" },
    ]);
    expect(plan.phases).toContainEqual({ title: "Phase A" });
    const loop = plan.nodes.find((n) => n.nodeId === "loop-task@@r=0");
    const plain = plan.nodes.find((n) => n.nodeId === "plain");
    expect(loop?.phase).toBe("Phase A");
    expect(plain?.phase).toBe("Phase A");
  });

  test("label falls back to nodeId when empty", () => {
    const plan = buildClaudeWorkflowPhasePlan(null, [{ nodeId: "n1", label: "", ordinal: 0, kind: "compute" }]);
    expect(plan.nodes[0].label).toBe("n1");
    expect(plan.nodes[0].phase).toBe("Workflow");
  });
});

describe("<Subflow> computeFn delegates to executeChildWorkflow", () => {
  /**
   * @param {(specifier: string) => Promise<any>} loader
   * @param {() => Promise<void>} fn
   */
  async function withLoader(loader, fn) {
    const restore = __setRuntimeModuleLoader(loader);
    try {
      await fn();
    } finally {
      restore();
    }
  }

  function subflowDescriptor() {
    const root = hostEl("smithers:workflow", {}, [
      hostEl("smithers:subflow", {
        id: "sf",
        output: "sf_out",
        dependsOn: ["dep1", 2],
        needs: { a: "b", c: 3 },
        __smithersSubflowWorkflow: { name: "child" },
        __smithersSubflowInput: { a: 1 },
      }),
    ]);
    const result = extractFromHost(root);
    const descriptor = result.tasks.find((t) => t.nodeId === "sf");
    expect(descriptor).toBeDefined();
    return descriptor;
  }

  test("returns the child run output on a finished child workflow", async () => {
    await withLoader(
      async (specifier) => {
        expect(specifier).toContain("child-workflow");
        return {
          executeChildWorkflow: async (_parent, opts) => {
            expect(opts.workflow).toEqual({ name: "child" });
            expect(opts.input).toEqual({ a: 1 });
            return { status: "finished", output: { done: true } };
          },
        };
      },
      async () => {
        const descriptor = subflowDescriptor();
        const out = await descriptor.computeFn();
        expect(out).toEqual({ done: true });
      },
    );
  });

  test("throws when the child workflow does not finish", async () => {
    await withLoader(
      async () => ({
        executeChildWorkflow: async () => ({ runId: "failed-child", status: "failed" }),
      }),
      async () => {
        const descriptor = subflowDescriptor();
        await expect(descriptor.computeFn()).rejects.toThrow(/failed-child ended with status failed/);
      },
    );
  });
});

describe("<Sandbox> computeFn delegates to executeSandbox", () => {
  /**
   * @param {(specifier: string) => Promise<any>} loader
   * @param {() => Promise<void>} fn
   */
  async function withLoader(loader, fn) {
    const restore = __setRuntimeModuleLoader(loader);
    try {
      await fn();
    } finally {
      restore();
    }
  }

  /** @param {Record<string, any>} rawProps */
  function sandboxDescriptor(rawProps) {
    const root = hostEl("smithers:workflow", {}, [
      hostEl("smithers:sandbox", {
        id: "sb",
        output: "sb_out",
        dependsOn: ["dep1", 2],
        needs: { a: "b", c: 3 },
        ...rawProps,
      }),
    ]);
    const result = extractFromHost(root);
    const descriptor = result.tasks.find((t) => t.nodeId === "sb");
    expect(descriptor).toBeDefined();
    return descriptor;
  }

  /** @returns {(specifier: string) => Promise<any>} */
  function runtimeLoader() {
    return async (specifier) => {
      if (specifier.endsWith("/execute")) {
        return { executeSandbox: async (args) => ({ ranWith: args }) };
      }
      if (specifier.includes("child-workflow")) {
        return { executeChildWorkflow: async () => ({ status: "finished", output: null }) };
      }
      if (specifier.includes("diff-bundle")) {
        return { applyDiffBundle: () => undefined };
      }
      throw new Error(`unexpected specifier ${specifier}`);
    };
  }

  test("invokes executeSandbox with the resolved runtime for a valid sandbox", async () => {
    await withLoader(runtimeLoader(), async () => {
      const descriptor = sandboxDescriptor({
        runtime: "docker",
        workflow: { name: "sbwf" },
        input: { x: 1 },
        allowNetwork: true,
      });
      const out = await descriptor.computeFn();
      expect(out.ranWith.sandboxId).toBe("sb");
      expect(out.ranWith.runtime).toBe("docker");
      expect(out.ranWith.workflow).toEqual({ name: "sbwf" });
      expect(out.ranWith.allowNetwork).toBe(true);
      expect(typeof out.ranWith.executeChildWorkflow).toBe("function");
      expect(typeof out.ranWith.applyDiffBundle).toBe("function");
    });
  });

  test("defaults an undefined runtime through to executeSandbox", async () => {
    await withLoader(runtimeLoader(), async () => {
      const descriptor = sandboxDescriptor({ workflow: { name: "sbwf" } });
      const out = await descriptor.computeFn();
      expect(out.ranWith.runtime).toBeUndefined();
    });
  });

  test("throws for an unsupported runtime", async () => {
    await withLoader(runtimeLoader(), async () => {
      const descriptor = sandboxDescriptor({ runtime: "vm", workflow: { name: "sbwf" } });
      await expect(descriptor.computeFn()).rejects.toThrow(/Unsupported sandbox runtime: vm/);
    });
  });

  test("throws when the sandbox is missing a workflow definition", async () => {
    await withLoader(runtimeLoader(), async () => {
      const descriptor = sandboxDescriptor({});
      await expect(descriptor.computeFn()).rejects.toThrow(/missing workflow definition/);
    });
  });
});

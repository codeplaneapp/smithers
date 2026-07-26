/**
 * Closes the remaining own-src coverage gaps for @smithers-orchestrator/react-reconciler:
 *
 *  - src/context.js            createSmithersContext() + useCtx() (both branches)
 *  - src/devtools/preload.js   side-effect module that installs the RDT hook
 *  - src/reconciler.js         element-parent removeChild / insertBefore host ops
 *  - src/devtools/SmithersDevTools.js  extractTaskInfo agent-array branch + wrappers
 *
 * The devtools cases drive real fibers through the installed React DevTools
 * global hook (a real bippy backend, not a mock), matching the existing
 * devtools-deep-wrapper.test.js pattern.
 */
import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SmithersRenderer } from "../src/dom/renderer.js";
import { __testingHostConfig, __testingInjectedDevToolsConfig } from "../src/reconciler.js";
import { createSmithersContext, SmithersContext } from "../src/context.js";
import { SmithersDevTools } from "../src/devtools/SmithersDevTools.js";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

const HOOK_KEY = "__REACT_DEVTOOLS_GLOBAL_HOOK__";
const HOST_COMPONENT_TAG = 5;

/**
 * @param {string | Function} type
 * @param {Record<string, unknown>} [props]
 * @returns {any}
 */
function fiber(type, props = {}) {
  return {
    tag: typeof type === "string" ? HOST_COMPONENT_TAG : 0,
    type,
    elementType: type,
    memoizedProps: props,
    child: null,
    sibling: null,
  };
}

/**
 * @param {any} parent
 * @param {any[]} children
 * @returns {any}
 */
function withChildren(parent, children) {
  parent.child = children[0] ?? null;
  for (let i = 0; i < children.length - 1; i += 1) {
    children[i].sibling = children[i + 1];
  }
  return parent;
}

// ---------------------------------------------------------------------------
// src/context.js
// ---------------------------------------------------------------------------
describe("createSmithersContext", () => {
  test("the module-level SmithersContext default context has the expected shape", () => {
    expect(SmithersContext.displayName).toBe("SmithersContext");
  });

  test("useCtx() returns the provided ctx when rendered under the Provider", async () => {
    const { SmithersContext: Context, useCtx } = createSmithersContext();
    expect(Context.displayName).toBe("SmithersContext");

    const ctxValue = { runId: "run-1", input: null };
    let captured = null;
    function Consumer() {
      captured = useCtx();
      return React.createElement("smithers:task", { id: "c", output: "out" });
    }

    const renderer = new SmithersRenderer({ extractGraph: (root) => ({ xml: root, tasks: [], mountedTaskIds: [] }) });
    await renderer.render(React.createElement(Context.Provider, { value: ctxValue }, React.createElement(Consumer)));
    expect(captured).toBe(ctxValue);
  });

  test("useCtx() throws CONTEXT_OUTSIDE_WORKFLOW when no Provider is mounted", async () => {
    const { useCtx } = createSmithersContext();
    function Consumer() {
      useCtx();
      return null;
    }
    const renderer = new SmithersRenderer({ extractGraph: (root) => ({ xml: root, tasks: [], mountedTaskIds: [] }) });
    const error = await renderer.render(React.createElement(Consumer)).then(
      () => null,
      (e) => e,
    );
    expect(error).toBeInstanceOf(SmithersError);
    expect(error.code).toBe("CONTEXT_OUTSIDE_WORKFLOW");
  });
});

// ---------------------------------------------------------------------------
// src/devtools/preload.js — side-effect module
// ---------------------------------------------------------------------------
describe("devtools/preload", () => {
  test("importing the preload installs the React DevTools global hook", async () => {
    await import("../src/devtools/preload.js");
    const hook = globalThis[HOOK_KEY];
    expect(hook).toBeDefined();
    expect(typeof hook.inject).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// src/reconciler.js — element-parent mutation host ops
// ---------------------------------------------------------------------------
describe("host config element-parent mutations", () => {
  test("registers the package identity and version with React DevTools", () => {
    const packageManifest = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8"));
    expect(__testingInjectedDevToolsConfig.rendererPackageName).toBe(packageManifest.name);
    expect(__testingInjectedDevToolsConfig.version).toBe(packageManifest.version);
  });

  test("the injected DevTools config resolves no fiber by host instance (headless)", () => {
    // react-reconciler stores this config internally and only invokes
    // findFiberByHostInstance when the React DevTools frontend queries by a
    // host node. Headless renders never do; assert the contract directly.
    const node = __testingHostConfig.createInstance("smithers:task", { id: "h" });
    expect(__testingInjectedDevToolsConfig.findFiberByHostInstance(node)).toBeNull();
  });

  test("read-only host context + finalize/commit stubs return their headless defaults", () => {
    const cfg = __testingHostConfig;
    expect(cfg.getRootHostContext()).toEqual({});
    expect(cfg.getChildHostContext()).toEqual({});
    const inst = cfg.createInstance("smithers:task", { id: "pub" });
    expect(cfg.getPublicInstance(inst)).toBe(inst);
    const text = cfg.createTextInstance("hello");
    expect(text).toEqual({ kind: "text", text: "hello" });
    cfg.appendInitialChild(inst, text);
    expect(inst.children).toEqual([text]);
    expect(cfg.finalizeInitialChildren()).toBe(false);
    expect(cfg.prepareForCommit()).toBeNull();
    expect(() => cfg.resetAfterCommit()).not.toThrow();
    expect(cfg.shouldSetTextContent()).toBe(false);

    // clearContainer wipes the roots and materialized root.
    const container = { root: inst, roots: [inst] };
    cfg.clearContainer(container);
    expect(container.root).toBeNull();
    expect(container.roots).toEqual([]);
  });

  test("removeChild removes a present child and no-ops on an absent one", () => {
    const parent = __testingHostConfig.createInstance("smithers:parallel", {});
    const a = __testingHostConfig.createInstance("smithers:task", { id: "a" });
    const b = __testingHostConfig.createInstance("smithers:task", { id: "b" });
    __testingHostConfig.appendChild(parent, a);
    __testingHostConfig.appendChild(parent, b);
    expect(parent.children.map((c) => c.props.id)).toEqual(["a", "b"]);

    __testingHostConfig.removeChild(parent, a);
    expect(parent.children.map((c) => c.props.id)).toEqual(["b"]);

    // Absent child: idx < 0, must be a no-op (not throw, not mutate).
    const orphan = __testingHostConfig.createInstance("smithers:task", { id: "z" });
    __testingHostConfig.removeChild(parent, orphan);
    expect(parent.children.map((c) => c.props.id)).toEqual(["b"]);
  });

  test("update-priority + no-op lifecycle host stubs are invocable and headless-safe", () => {
    const cfg = __testingHostConfig;

    // Update-priority accessors round-trip through the module-level lane.
    const original = cfg.getCurrentUpdatePriority();
    try {
      cfg.setCurrentUpdatePriority(4);
      expect(cfg.getCurrentUpdatePriority()).toBe(4);
      expect(cfg.resolveUpdatePriority()).toBe(4);
    } finally {
      // Restore so we don't perturb scheduling for other tests.
      cfg.setCurrentUpdatePriority(original);
    }
    expect(cfg.getCurrentUpdatePriority()).toBe(original);

    // Headless no-op suspense/form/instance lifecycle hooks: must not throw.
    const instance = cfg.createInstance("smithers:task", { id: "s" });
    expect(() => cfg.preloadInstance(instance)).not.toThrow();
    expect(() => cfg.startSuspendingCommit()).not.toThrow();
    expect(() => cfg.suspendInstance(instance)).not.toThrow();
    expect(() => cfg.resetFormInstance(instance)).not.toThrow();
    expect(() => cfg.detachDeletedInstance(instance)).not.toThrow();
  });

  test("insertBefore inserts, moves an existing child, and appends when the anchor is missing", () => {
    const parent = __testingHostConfig.createInstance("smithers:parallel", {});
    const a = __testingHostConfig.createInstance("smithers:task", { id: "a" });
    const b = __testingHostConfig.createInstance("smithers:task", { id: "b" });
    const c = __testingHostConfig.createInstance("smithers:task", { id: "c" });
    __testingHostConfig.appendChild(parent, a);
    __testingHostConfig.appendChild(parent, b);

    // Insert c before b -> [a, c, b] (existing < 0, anchor found).
    __testingHostConfig.insertBefore(parent, c, b);
    expect(parent.children.map((child) => child.props.id)).toEqual(["a", "c", "b"]);

    // Move a (already present) before b -> remove a first, then insert -> [c, a, b].
    __testingHostConfig.insertBefore(parent, a, b);
    expect(parent.children.map((child) => child.props.id)).toEqual(["c", "a", "b"]);

    // Anchor not in the list: falls through to append at the end.
    const d = __testingHostConfig.createInstance("smithers:task", { id: "d" });
    const missingAnchor = __testingHostConfig.createInstance("smithers:task", { id: "missing" });
    __testingHostConfig.insertBefore(parent, d, missingAnchor);
    expect(parent.children.map((child) => child.props.id)).toEqual(["c", "a", "b", "d"]);
  });
});

// ---------------------------------------------------------------------------
// src/devtools/SmithersDevTools.js — extractTaskInfo agent-array + wrappers
// ---------------------------------------------------------------------------
describe("SmithersDevTools agent metadata + wrapper methods", () => {
  /** @type {unknown} */
  let priorHook;

  afterEach(() => {
    if (priorHook === undefined) {
      delete globalThis[HOOK_KEY];
    } else {
      globalThis[HOOK_KEY] = priorHook;
    }
  });

  test("extractTaskInfo joins an agent array (failover chain) into one label", () => {
    priorHook = globalThis[HOOK_KEY];
    globalThis[HOOK_KEY] = {
      renderers: new Map(),
      supportsFiber: true,
      inject() {
        return 1;
      },
      on() {},
      off() {},
      emit() {},
    };

    const workflow = fiber("smithers:workflow", { name: "agents" });
    const arrayTask = fiber("smithers:task", {
      id: "failover",
      __smithersKind: "agent",
      agent: [{ modelId: "opus" }, { model: "sonnet" }, {}],
    });
    const objectTask = fiber("smithers:task", {
      id: "single",
      __smithersKind: "agent",
      agent: { modelId: "haiku" },
    });
    const bareTask = fiber("smithers:task", {
      id: "bare-agent",
      __smithersKind: "agent",
      agent: {},
    });
    withChildren(workflow, [arrayTask, objectTask, bareTask]);

    const devtools = new SmithersDevTools();
    devtools.start();
    const hook = globalThis[HOOK_KEY];
    hook.onCommitFiberRoot(1, { current: workflow });

    expect(devtools.findTask("failover")?.task?.agent).toBe("opus → sonnet → ?");
    expect(devtools.findTask("single")?.task?.agent).toBe("haiku");
    expect(devtools.findTask("bare-agent")?.task?.agent).toBe("agent");
    devtools.stop();
  });

  test("public wrapper accessors delegate to the core for an unstarted instance", () => {
    const devtools = new SmithersDevTools();
    expect(devtools.runs).toBe(devtools.core.runs);
    expect(devtools.snapshot).toBe(devtools.core.snapshot);
    expect(devtools.tree).toBe(devtools.core.tree);
    expect(devtools.listTasks()).toEqual([]);
    expect(devtools.findTask("nope")).toBeNull();
    expect(devtools.getRun("nope")).toBeUndefined();
    expect(devtools.getTaskState("nope", "nope")).toBeUndefined();
    expect(typeof devtools.printTree()).toBe("string");
  });
});

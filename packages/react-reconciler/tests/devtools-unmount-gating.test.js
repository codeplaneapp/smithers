/**
 * Regression test: the React DevTools global hook is shared by every renderer
 * on the page, so `onCommitFiberUnmount` fires for composite fibers, ordinary
 * host fibers (`div`), and fibers belonging to other renderers. Only Smithers
 * host fibers (`smithers:*`) may produce a public "unmount" callback.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { SmithersDevTools } from "../src/devtools/SmithersDevTools.js";

const HOOK_KEY = "__REACT_DEVTOOLS_GLOBAL_HOOK__";
const FUNCTION_COMPONENT_TAG = 0;
const CLASS_COMPONENT_TAG = 1;
const HOST_COMPONENT_TAG = 5;

/** @type {unknown} */
let priorHook;

/**
 * @param {number} tag
 * @param {unknown} type
 * @returns {any}
 */
function fiber(tag, type) {
  return {
    tag,
    type,
    elementType: type,
    memoizedProps: { id: "n1" },
    child: null,
    sibling: null,
    return: null,
  };
}

function TaskComponent() {
  return null;
}

describe("SmithersDevTools onCommitFiberUnmount gating", () => {
  beforeEach(() => {
    priorHook = /** @type {Record<string, unknown>} */ (globalThis)[HOOK_KEY];
    /** @type {Record<string, unknown>} */ (globalThis)[HOOK_KEY] = {
      renderers: new Map(),
      supportsFiber: true,
      inject() {
        return 1;
      },
      on() {},
      off() {},
      emit() {},
    };
  });

  afterEach(() => {
    if (priorHook === undefined) {
      delete (/** @type {Record<string, unknown>} */ (globalThis)[HOOK_KEY]);
    } else {
      /** @type {Record<string, unknown>} */ (globalThis)[HOOK_KEY] = priorHook;
    }
  });

  /**
   * @param {any} unmounted
   * @returns {string[]}
   */
  function eventsForUnmount(unmounted) {
    /** @type {string[]} */
    const events = [];
    const devtools = new SmithersDevTools({
      onCommit: (event) => events.push(event),
    });
    devtools.start();
    try {
      const hook = /** @type {any} */ (globalThis[HOOK_KEY]);
      hook.onCommitFiberUnmount(1, unmounted);
      hook.onCommitFiberRoot(1, { current: fiber(HOST_COMPONENT_TAG, "div") });
    } finally {
      devtools.stop();
    }
    return events;
  }

  for (const [label, unmounted] of /** @type {[string, any][]} */ ([
    ["composite function fiber", fiber(FUNCTION_COMPONENT_TAG, TaskComponent)],
    ["composite class fiber", fiber(CLASS_COMPONENT_TAG, class Workflow {})],
    ["ordinary host fiber (div)", fiber(HOST_COMPONENT_TAG, "div")],
    ["foreign renderer host fiber (custom-element)", fiber(HOST_COMPONENT_TAG, "custom-element")],
    ["fiber with no resolvable type", fiber(HOST_COMPONENT_TAG, null)],
  ])) {
    test(`does not emit unmount for a ${label}`, () => {
      expect(eventsForUnmount(unmounted)).toEqual([]);
    });
  }

  for (const hostType of ["smithers:workflow", "smithers:task", "smithers:parallel"]) {
    test(`emits unmount for the smithers host fiber ${hostType}`, () => {
      expect(eventsForUnmount(fiber(HOST_COMPONENT_TAG, hostType))).toEqual(["unmount"]);
    });
  }

  test("only smithers host fibers survive a mixed unmount batch", () => {
    /** @type {string[]} */
    const events = [];
    const devtools = new SmithersDevTools({
      onCommit: (event) => events.push(event),
    });
    devtools.start();
    try {
      const hook = /** @type {any} */ (globalThis[HOOK_KEY]);
      hook.onCommitFiberUnmount(1, fiber(FUNCTION_COMPONENT_TAG, TaskComponent));
      hook.onCommitFiberUnmount(1, fiber(HOST_COMPONENT_TAG, "div"));
      hook.onCommitFiberUnmount(1, fiber(HOST_COMPONENT_TAG, "smithers:task"));
      hook.onCommitFiberUnmount(1, fiber(HOST_COMPONENT_TAG, "span"));
      hook.onCommitFiberRoot(1, { current: fiber(HOST_COMPONENT_TAG, "div") });
    } finally {
      devtools.stop();
    }
    expect(events).toEqual(["unmount"]);
  });

  test("verbose logging stays silent for non-smithers fibers", () => {
    /** @type {unknown[][]} */
    const logged = [];
    const priorLog = console.log;
    console.log = (/** @type {unknown[]} */ ...args) => {
      logged.push(args);
    };
    const devtools = new SmithersDevTools({ verbose: true });
    devtools.start();
    try {
      const hook = /** @type {any} */ (globalThis[HOOK_KEY]);
      hook.onCommitFiberUnmount(1, fiber(HOST_COMPONENT_TAG, "div"));
      hook.onCommitFiberUnmount(1, fiber(FUNCTION_COMPONENT_TAG, TaskComponent));
    } finally {
      devtools.stop();
      console.log = priorLog;
    }
    expect(logged).toEqual([]);
  });
});

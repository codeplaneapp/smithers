import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SmithersDevTools } from "../src/devtools/SmithersDevTools.js";

const HOOK_KEY = "__REACT_DEVTOOLS_GLOBAL_HOOK__";
const HOST_COMPONENT_TAG = 5;

/** @type {unknown} */
let priorHook;

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

describe("SmithersDevTools wrapped fiber traversal", () => {
    beforeEach(() => {
        priorHook = /** @type {Record<string, unknown>} */ (globalThis)[HOOK_KEY];
        (/** @type {Record<string, unknown>} */ (globalThis))[HOOK_KEY] = {
            renderers: new Map(),
            supportsFiber: true,
            inject() { return 1; },
            on() {},
            off() {},
            emit() {},
        };
    });

    afterEach(() => {
        if (priorHook === undefined) {
            delete (/** @type {Record<string, unknown>} */ (globalThis))[HOOK_KEY];
        } else {
            (/** @type {Record<string, unknown>} */ (globalThis))[HOOK_KEY] = priorHook;
        }
    });

    test("captures Smithers nodes nested more than one non-Smithers fiber deep", () => {
        const workflow = fiber("smithers:workflow", { name: "wrapped" });
        const outerWrapper = fiber(function OuterWrapper() {});
        const innerWrapper = fiber(function InnerWrapper() {});
        const task = fiber("smithers:task", {
            id: "deep-task",
            label: "Deep task",
            __smithersKind: "static",
        });

        withChildren(workflow, [
            withChildren(outerWrapper, [
                withChildren(innerWrapper, [task]),
            ]),
        ]);

        const devtools = new SmithersDevTools();
        devtools.start();

        const hook = /** @type {any} */ (globalThis[HOOK_KEY]);
        hook.onCommitFiberRoot(1, { current: workflow });

        expect(devtools.tree?.children).toHaveLength(1);
        expect(devtools.tree?.children[0]?.type).toBe("task");
        expect(devtools.tree?.children[0]?.task?.nodeId).toBe("deep-task");

        devtools.stop();
    });
});

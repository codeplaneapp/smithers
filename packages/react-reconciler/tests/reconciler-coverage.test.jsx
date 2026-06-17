/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import React from "react";
import { SmithersRenderer } from "../src/dom/renderer.js";
import { importCoreModule, resolveExtractGraph } from "../src/core-peer.js";
import { SmithersDevTools } from "../src/devtools/SmithersDevTools.js";
import { __testingHostConfig } from "../src/reconciler.js";

const HOOK_KEY = "__REACT_DEVTOOLS_GLOBAL_HOOK__";

afterEach(() => {
    mock.restore();
});

describe("core peer resolution", () => {
    test("falls back to the local graph module when the package import is unavailable", async () => {
        const fallback = () => ({ ok: true });
        const extractGraph = await resolveExtractGraph(async (specifier) => {
            if (specifier === "@smithers-orchestrator/graph")
                return null;
            return { extractGraph: fallback };
        });

        expect(extractGraph).toBe(fallback);
    });

    test("throws when neither core module exports extractGraph", async () => {
        await expect(resolveExtractGraph(async () => ({}))).rejects.toThrow(
            "Unable to load extractGraph from @smithers-orchestrator/graph",
        );
    });

    test("importCoreModule returns null when dynamic import fails", async () => {
        const mod = await importCoreModule("@smithers-orchestrator/definitely-missing");

        expect(mod).toBeNull();
    });
});

describe("host config defensive branches", () => {
    test("commitUpdate accepts current, legacy, and payload-first signatures", () => {
        const instance = __testingHostConfig.createInstance("smithers:task", {
            id: "before",
            output: "out",
            ignored: undefined,
        });

        __testingHostConfig.commitUpdate(instance, { id: "current", skipIf: true }, "smithers:task");
        expect(instance.props).toEqual({ id: "current", skipIf: "true" });

        __testingHostConfig.commitUpdate(instance, "smithers:task", {}, { id: "legacy", count: 2 });
        expect(instance.props).toEqual({ id: "legacy", count: "2" });

        __testingHostConfig.commitUpdate(instance, { id: "payload" });
        expect(instance.props).toEqual({ id: "payload" });

        __testingHostConfig.commitUpdate(instance, null);
        expect(instance.props).toEqual({ id: "payload" });
    });

    test("0.33 host stubs return headless defaults and schedule work", async () => {
        const calls = [];
        const timeout = __testingHostConfig.scheduleTimeout(() => calls.push("timeout"), 0);

        await new Promise((resolve) => {
            __testingHostConfig.scheduleMicrotask(() => {
                calls.push("microtask");
                resolve(undefined);
            });
        });

        __testingHostConfig.cancelTimeout(timeout);
        expect(calls).toEqual(["microtask"]);
        expect(__testingHostConfig.getCurrentEventPriority()).toBe(1);
        expect(__testingHostConfig.shouldAttemptEagerTransition()).toBe(false);
        expect(__testingHostConfig.maySuspendCommit()).toBe(false);
        expect(__testingHostConfig.waitForCommitToBeReady()).toBeNull();
        expect(__testingHostConfig.resolveEventTimeStamp()).toBe(-1.1);
        expect(__testingHostConfig.resolveEventType()).toBeNull();
        expect(__testingHostConfig.maySuspendCommitOnUpdate()).toBe(false);
        expect(__testingHostConfig.maySuspendCommitInSyncRender()).toBe(false);
        expect(__testingHostConfig.getSuspendedCommitReason()).toBeNull();
        expect(__testingHostConfig.suspendOnActiveViewTransition()).toBe(false);
        expect(__testingHostConfig.noTimeout).toBe(-1);
        expect(() => __testingHostConfig.trackSchedulerEvent()).not.toThrow();
        expect(() => __testingHostConfig.requestPostPaintCallback()).not.toThrow();
    });

    test("container mutation stubs update the headless root", () => {
        const container = { root: null };
        const first = __testingHostConfig.createInstance("smithers:task", { id: "first" });
        const second = __testingHostConfig.createInstance("smithers:task", { id: "second" });

        __testingHostConfig.appendChildToContainer(container, first);
        expect(container.root).toBe(first);

        __testingHostConfig.insertInContainerBefore(container, second, first);
        expect(container.root).toBe(second);

        __testingHostConfig.removeChildFromContainer(container);
        expect(container.root).toBeNull();
    });

    test("bindToConsole dispatches to the selected console method with log fallback", () => {
        const info = spyOn(console, "info").mockImplementation(() => {});
        const log = spyOn(console, "log").mockImplementation(() => {});
        const priorDebug = console.debug;

        try {
            __testingHostConfig.bindToConsole("info", ["hello", 1])();
            expect(info).toHaveBeenCalledWith("hello", 1);

            console.debug = undefined;
            __testingHostConfig.bindToConsole("debug", ["fallback"])();
            expect(log).toHaveBeenCalledWith("fallback");
        }
        finally {
            console.debug = priorDebug;
            info.mockRestore();
            log.mockRestore();
        }
    });

    test("commitTextUpdate is exercised by changing rendered text", async () => {
        const renderer = new SmithersRenderer({ extractGraph: async (root) => ({ root }) });

        await renderer.render(React.createElement("smithers:task", { id: "t1", output: "out" }, "before"));
        await renderer.render(React.createElement("smithers:task", { id: "t1", output: "out" }, "after"));

        const root = renderer.getRoot();
        expect(root?.children[0]?.kind).toBe("text");
        expect(root?.children[0]?.text).toBe("after");
    });
});

describe("SmithersDevTools verbose commit logging", () => {
    test("logs commit and unmount details when verbose is enabled", () => {
        const priorHook = globalThis[HOOK_KEY];
        globalThis[HOOK_KEY] = {
            renderers: new Map(),
            supportsFiber: true,
            inject() { return 1; },
            on() {},
            off() {},
            emit() {},
        };
        const log = spyOn(console, "log").mockImplementation(() => {});

        try {
            const devtools = new SmithersDevTools({ verbose: true });
            devtools.start();
            expect(devtools.runs).toBe(devtools.core.runs);
            const hook = globalThis[HOOK_KEY];
            const workflowFiber = {
                type: "smithers:workflow",
                memoizedProps: { name: "wf" },
                child: null,
                sibling: null,
                return: null,
            };

            hook.onCommitFiberRoot(1, { current: workflowFiber });
            hook.onCommitFiberUnmount(1, workflowFiber);

            expect(log).toHaveBeenCalledTimes(2);
            expect(String(log.mock.calls[0][0])).toContain("[smithers-devtools] Commit detected");
            expect(String(log.mock.calls[1][0])).toContain("[smithers-devtools] Unmounted: workflow");
            devtools.stop();
        }
        finally {
            log.mockRestore();
            if (priorHook === undefined) {
                delete globalThis[HOOK_KEY];
            }
            else {
                globalThis[HOOK_KEY] = priorHook;
            }
        }
    });
});

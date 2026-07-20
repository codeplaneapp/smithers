import Reconciler from "react-reconciler";
import { installRDTHook } from "bippy";
import { resolveDefaultWorktreePathResolver, resolveExtractGraph } from "./core-peer.js";
/** @typedef {import("@smithers-orchestrator/graph/types").ExtractGraph} ExtractGraph */
/** @typedef {import("@smithers-orchestrator/graph/types").ExtractOptions} ExtractOptions */
/** @typedef {import("./HostContainer.ts").HostContainer} HostContainer */
/** @typedef {import("@smithers-orchestrator/graph/types").HostElement & { props: Record<string, string>; rawProps: Record<string, unknown>; children: HostNode[] }} MutableHostElement */
/** @typedef {import("@smithers-orchestrator/graph/types").HostNode} HostNode */
/** @typedef {import("@smithers-orchestrator/graph/types").HostText & { text: string }} MutableHostText */
/** @typedef {import("react").default} React */
/** @typedef {import("./SmithersRendererOptions.ts").SmithersRendererOptions} SmithersRendererOptions */
/** @typedef {import("@smithers-orchestrator/graph/types").WorkflowGraph} WorkflowGraph */
/**
 * Minimal local shape for a react-reconciler instance. `@types/react-reconciler`
 * is not installed here, so we describe only the methods we call.
 * @typedef {{
 *   createContainer: (
 *     rootContainer: unknown,
 *     tag: number,
 *     hydrationCallbacks: unknown,
 *     isStrictMode: boolean,
 *     concurrentUpdatesByDefaultOverride: unknown,
 *     identifierPrefix: string,
 *     onUncaughtError: unknown,
 *     onCaughtError: unknown,
 *     onRecoverableError: unknown,
 *     transitionCallbacks: unknown,
 *   ) => unknown;
 *   updateContainerSync: (element: unknown, container: unknown, parentComponent: unknown, callback: () => void) => void;
 *   flushSyncWork: () => void;
 *   injectIntoDevTools: (devtools: unknown) => void;
 *   defaultOnUncaughtError: unknown;
 *   defaultOnCaughtError: unknown;
 *   defaultOnRecoverableError: unknown;
 * }} ReconcilerInstance */

/**
 * @param {string} type
 * @param {Record<string, unknown>} props
 * @returns {MutableHostElement}
 */
function createElement(type, props) {
    const { children: _children, ...rest } = props || {};
    const stringProps = {};
    for (const [key, value] of Object.entries(rest)) {
        if (value === undefined || typeof value === "function")
            continue;
        if (key.startsWith("__"))
            continue;
        if (typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean") {
            stringProps[key] = String(value);
        }
    }
    return {
        kind: "element",
        tag: type,
        props: stringProps,
        rawProps: props ?? {},
        children: [],
    };
}
// Historical hardcoded lane value this headless host has always reported.
// NOT react-reconciler's DefaultEventPriority (32 in 0.33.0; 1 is React 19's
// SyncHydrationLane) — do not "correct" it, that would change scheduling.
const HEADLESS_UPDATE_PRIORITY = 1;
let currentUpdatePriority = HEADLESS_UPDATE_PRIORITY;
/**
 * @param {readonly HostNode[]} roots
 * @returns {HostNode | null}
 */
function materializeRoot(roots) {
    if (roots.length === 0)
        return null;
    if (roots.length === 1)
        return roots[0];
    return {
        kind: "element",
        tag: "smithers:fragment",
        props: {},
        rawProps: {},
        children: roots,
    };
}
/**
 * @param {HostContainer} container
 * @returns {HostNode[]}
 */
function ensureContainerRoots(container) {
    if (Array.isArray(container.roots))
        return container.roots;
    container.roots = container.root ? [container.root] : [];
    return container.roots;
}
/**
 * @param {HostContainer} container
 * @returns {void}
 */
function refreshContainerRoot(container) {
    container.root = materializeRoot(ensureContainerRoots(container));
}
const hostConfig = {
    supportsMutation: true,
    supportsPersistence: false,
    supportsHydration: false,
    isPrimaryRenderer: true,
    supportsMicrotasks: true,
    /**
   * @returns {Record<string, unknown>}
   */
    getRootHostContext() {
        return {};
    },
    /**
   * @returns {Record<string, unknown>}
   */
    getChildHostContext() {
        return {};
    },
    /**
   * @param {unknown} instance
   * @returns {unknown}
   */
    getPublicInstance(instance) {
        return instance;
    },
    /**
   * @param {string} type
   * @param {Record<string, unknown>} props
   * @returns {MutableHostElement}
   */
    createInstance(type, props) {
        return createElement(type, props);
    },
    /**
   * @param {string} text
   * @returns {MutableHostText}
   */
    createTextInstance(text) {
        return { kind: "text", text };
    },
    /**
   * @param {MutableHostElement} parent
   * @param {HostNode} child
   * @returns {void}
   */
    appendInitialChild(parent, child) {
        parent.children.push(child);
    },
    /**
   * @param {MutableHostElement} parent
   * @param {HostNode} child
   * @returns {void}
   */
    appendChild(parent, child) {
        const existing = parent.children.indexOf(child);
        if (existing >= 0)
            parent.children.splice(existing, 1);
        parent.children.push(child);
    },
    /**
   * @param {HostContainer} container
   * @param {HostNode} child
   * @returns {void}
   */
    appendChildToContainer(container, child) {
        const roots = ensureContainerRoots(container);
        const existing = roots.indexOf(child);
        if (existing >= 0)
            roots.splice(existing, 1);
        roots.push(child);
        refreshContainerRoot(container);
    },
    /**
   * @param {MutableHostElement} parent
   * @param {HostNode} child
   * @returns {void}
   */
    removeChild(parent, child) {
        const idx = parent.children.indexOf(child);
        if (idx >= 0)
            parent.children.splice(idx, 1);
    },
    /**
   * @param {HostContainer} container
   * @param {HostNode} [child]
   * @returns {void}
   */
    removeChildFromContainer(container, child) {
        const roots = ensureContainerRoots(container);
        if (child) {
            const idx = roots.indexOf(child);
            if (idx >= 0)
                roots.splice(idx, 1);
        }
        else {
            roots.length = 0;
        }
        refreshContainerRoot(container);
    },
    /**
   * @param {MutableHostElement} parent
   * @param {HostNode} child
   * @param {HostNode} beforeChild
   * @returns {void}
   */
    insertBefore(parent, child, beforeChild) {
        const existing = parent.children.indexOf(child);
        if (existing >= 0)
            parent.children.splice(existing, 1);
        const idx = parent.children.indexOf(beforeChild);
        if (idx >= 0)
            parent.children.splice(idx, 0, child);
        else
            parent.children.push(child);
    },
    /**
   * @param {HostContainer} container
   * @param {HostNode} child
   * @param {HostNode} beforeChild
   * @returns {void}
   */
    insertInContainerBefore(container, child, beforeChild) {
        const roots = ensureContainerRoots(container);
        const existing = roots.indexOf(child);
        if (existing >= 0)
            roots.splice(existing, 1);
        const idx = roots.indexOf(beforeChild);
        if (idx >= 0)
            roots.splice(idx, 0, child);
        else
            roots.push(child);
        refreshContainerRoot(container);
    },
    /**
   * @param {MutableHostElement} instance
   * @param {unknown[]} args
   * @returns {void}
   */
    commitUpdate(instance, ...args) {
        let nextProps = null;
        const first = args[0];
        const second = args[1];
        if (typeof second === "string" && first && typeof first === "object") {
            nextProps = first;
        }
        else if (typeof first === "string") {
            const maybeNewProps = args[2];
            if (maybeNewProps && typeof maybeNewProps === "object") {
                nextProps = maybeNewProps;
            }
        }
        else if (first && typeof first === "object") {
            nextProps = first;
        }
        if (!nextProps)
            return;
        const next = createElement(instance.tag, nextProps);
        instance.props = next.props;
        instance.rawProps = next.rawProps;
    },
    /**
   * @param {MutableHostText} textInstance
   * @param {string} _oldText
   * @param {string} newText
   * @returns {void}
   */
    commitTextUpdate(textInstance, _oldText, newText) {
        textInstance.text = newText;
    },
    /**
   * @returns {boolean}
   */
    finalizeInitialChildren() {
        return false;
    },
    /**
   * @returns {null}
   */
    prepareForCommit() {
        return null;
    },
    /**
   * @returns {void}
   */
    resetAfterCommit() { },
    /**
   * @returns {boolean}
   */
    shouldSetTextContent() {
        return false;
    },
    /**
   * @param {HostContainer} container
   * @returns {void}
   */
    clearContainer(container) {
        ensureContainerRoots(container).length = 0;
        refreshContainerRoot(container);
    },
    /**
   * @returns {number}
   */
    getCurrentEventPriority() {
        return HEADLESS_UPDATE_PRIORITY;
    },
    /**
   * @returns {boolean}
   */
    shouldAttemptEagerTransition() {
        return false;
    },
    /**
   * @returns {boolean}
   */
    maySuspendCommit() {
        return false;
    },
    /**
   * @returns {void}
   */
    preloadInstance() { },
    /**
   * @returns {void}
   */
    startSuspendingCommit() { },
    /**
   * @returns {void}
   */
    suspendInstance() { },
    /**
   * @returns {null}
   */
    waitForCommitToBeReady() {
        return null;
    },
    /**
   * @returns {void}
   */
    resetFormInstance() { },
    /**
   * @returns {void}
   */
    detachDeletedInstance() { },
    /**
   * @param {"error" | "warn" | "info" | "log"} type
   * @param {unknown[]} args
   * @returns {() => void}
   */
    bindToConsole(type, args) {
        return () => {
            const fn = console[type] ?? console.log;
            fn(...args);
        };
    },
    /**
   * @returns {number}
   */
    getCurrentUpdatePriority() {
        return currentUpdatePriority;
    },
    /**
   * @param {number} priority
   * @returns {void}
   */
    setCurrentUpdatePriority(priority) {
        currentUpdatePriority = priority;
    },
    /**
   * @returns {number}
   */
    resolveUpdatePriority() {
        return currentUpdatePriority;
    },
    /**
   * The remaining methods below are required by react-reconciler >=0.33's
   * host config — the compiled reconciler reads each directly off `$$$config`
   * with no defaults, so missing methods surface as `TypeError: X is not a
   * function` the first time `render` triggers `startUpdateTimerByLane`
   * (which is every commit). Headless host → event timing is "no event"
   * (-1.1 sentinel), event type is null, no suspense, no scheduler telemetry.
   * @returns {number}
   */
    resolveEventTimeStamp() {
        return -1.1;
    },
    /**
   * @returns {string | null}
   */
    resolveEventType() {
        return null;
    },
    /**
   * @returns {void}
   */
    trackSchedulerEvent() { },
    /**
   * @returns {boolean}
   */
    maySuspendCommitOnUpdate() {
        return false;
    },
    /**
   * @returns {boolean}
   */
    maySuspendCommitInSyncRender() {
        return false;
    },
    /**
   * @returns {null}
   */
    getSuspendedCommitReason() {
        return null;
    },
    /**
   * @returns {void}
   */
    requestPostPaintCallback() { },
    /**
   * @returns {boolean}
   */
    suspendOnActiveViewTransition() {
        return false;
    },
    /**
   * @param {(...args: unknown[]) => void} fn
   * @param {number} [delay]
   * @returns {ReturnType<typeof setTimeout>}
   */
    scheduleTimeout(fn, delay) {
        return setTimeout(fn, delay ?? 0);
    },
    /**
   * @param {() => void} fn
   * @returns {void}
   */
    scheduleMicrotask(fn) {
        queueMicrotask(fn);
    },
    /**
   * @param {ReturnType<typeof setTimeout>} id
   * @returns {void}
   */
    cancelTimeout(id) {
        clearTimeout(id);
    },
    noTimeout: -1,
};
export const __testingHostConfig = hostConfig;
/** @type {ReconcilerInstance} */
const reconciler = /** @type {ReconcilerInstance} */ (Reconciler(hostConfig));
const hookHost = globalThis;
if (!hookHost.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
    installRDTHook();
}
const injectedDevToolsConfig = {
    bundleType: typeof process !== "undefined" && process.env.NODE_ENV === "production" ? 0 : 1,
    version: "0.29.1",
    rendererPackageName: "@smithers-orchestrator/react-reconciler",
    findFiberByHostInstance: () => null,
};
reconciler.injectIntoDevTools(injectedDevToolsConfig);
// Exposed for tests only. react-reconciler consumes this config internally and
// never re-exposes `findFiberByHostInstance`, so this is the sole in-process
// handle for asserting the headless "no host-instance fiber lookup" contract.
export const __testingInjectedDevToolsConfig = injectedDevToolsConfig;
export class SmithersRenderer {
    /** @type {HostContainer} */
    container;
    /** @type {unknown} */
    root;
    /** @type {ExtractGraph | undefined} */
    extractGraph;
    /**
   * Error captured by the synchronous flush of the most recent render. An
   * uncaught render error (no error boundary handled it) is fatal: the host
   * tree is left in an undefined/partial state, so render() must surface it
   * rather than resolve with a stale graph.
   * @type {unknown}
   */
    #uncaughtError;
    /**
   * @param {SmithersRendererOptions} [options]
   */
    constructor(options = {}) {
        this.extractGraph = options.extractGraph;
        this.container = { root: null, roots: [] };
        this.#uncaughtError = undefined;
        // Capture uncaught render errors synchronously instead of using
        // reconciler.defaultOnUncaughtError, which rethrows them out-of-band to
        // the global error handler. Capturing lets render() reject loudly so a
        // caller never receives a partial/stale graph as if it were valid.
        // Errors handled by an error boundary (onCaughtError) and recoverable
        // errors keep React's default behavior — those are not fatal.
        this.root = reconciler.createContainer(this.container, 0, null, false, null, "", (error) => {
            this.#uncaughtError = error;
        }, reconciler.defaultOnCaughtError, reconciler.defaultOnRecoverableError, null);
    }
    /**
   * @param {React.ReactElement} element
   * @param {ExtractOptions} [opts]
   * @returns {Promise<WorkflowGraph>}
   */
    async render(element, opts) {
        this.#uncaughtError = undefined;
        reconciler.updateContainerSync(element, this.root, null, () => { });
        reconciler.flushSyncWork();
        if (this.#uncaughtError !== undefined) {
            const error = this.#uncaughtError;
            // Reset so a subsequent render() on the same instance is not poisoned
            // by a prior failure.
            this.#uncaughtError = undefined;
            throw error;
        }
        const extractGraph = this.extractGraph ?? (await resolveExtractGraph());
        const resolveWorktreePath = opts?.resolveWorktreePath ?? (await resolveDefaultWorktreePathResolver());
        return extractGraph(this.container.root, resolveWorktreePath ? { ...opts, resolveWorktreePath } : opts);
    }
    /**
   * @returns {HostNode | null}
   */
    getRoot() {
        return this.container.root;
    }
}

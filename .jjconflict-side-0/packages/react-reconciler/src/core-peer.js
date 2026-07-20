
/** @typedef {import("@smithers-orchestrator/graph/types").ExtractGraph} ExtractGraph */
/** @typedef {{ extractGraph?: ExtractGraph }} CoreModule */
/** @typedef {{ resolveWorktreePath?: (path: string, opts?: { baseRootDir?: string; workflowPath?: string | null }) => string }} WorktreePathModule */
const GRAPH_SPECIFIER = "@smithers-orchestrator/graph";
// In-repo dev fallback: resolves packages/graph/src when the workspace package specifier is not installed.
const LOCAL_GRAPH_SPECIFIER = "../../graph/src/index.js";
/**
 * @param {string} specifier
 * @returns {Promise<CoreModule | null>}
 */
export async function importCoreModule(specifier) {
    try {
        return (await import(specifier));
    }
    catch {
        return null;
    }
}
/**
 * @returns {Promise<ExtractGraph>}
 */
export async function resolveExtractGraph(importModule = importCoreModule) {
    const packageExtractGraph = (await importModule(GRAPH_SPECIFIER))?.extractGraph;
    if (typeof packageExtractGraph === "function") {
        return packageExtractGraph;
    }
    const localExtractGraph = (await importModule(LOCAL_GRAPH_SPECIFIER))?.extractGraph;
    if (typeof localExtractGraph === "function") {
        return localExtractGraph;
    }
    throw new Error("Unable to load extractGraph from @smithers-orchestrator/graph. " +
        "Install @smithers-orchestrator/graph and ensure it exports extractGraph.");
}
/**
 * Node-default `<Worktree path>` resolver, loaded lazily (via a
 * non-literal dynamic `import()` specifier, so bundlers targeting other
 * runtimes never try to resolve it) so `extractGraph`'s own module never
 * statically imports the Node-only `resolveWorktreePath` (which pulls in
 * `node:path`). Only used when a caller renders without an explicit
 * `opts.resolveWorktreePath` — e.g. every pre-existing Node test/caller that
 * predates the `RuntimeAdapter` seam. A caller that supplies its own resolver
 * (the browser adapter's `RuntimeCapabilityError`-throwing one, or the
 * concrete Node engine's explicit wiring) never reaches this at all.
 * @param {(specifier: string) => Promise<WorktreePathModule | null>} [importModule]
 * @returns {Promise<((path: string, opts?: { baseRootDir?: string; workflowPath?: string | null }) => string) | undefined>}
 */
export async function resolveDefaultWorktreePathResolver(importModule = importCoreModule) {
    const modules = [
        await importModule(GRAPH_SPECIFIER),
        await importModule(LOCAL_GRAPH_SPECIFIER),
    ];
    for (const mod of modules) {
        const fn = mod?.resolveWorktreePath;
        if (typeof fn === "function") {
            return fn;
        }
    }
    return undefined;
}

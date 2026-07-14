
/** @typedef {import("@smithers-orchestrator/graph/types").ExtractGraph} ExtractGraph */
/** @typedef {{ extractGraph?: ExtractGraph }} CoreModule */
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

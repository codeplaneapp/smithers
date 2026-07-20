import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

const OPTIMIZATION_ARTIFACT_ENV = "SMITHERS_OPTIMIZATION_ARTIFACT";

/** @type {Map<string, { mtimeMs: number; artifact: any }>} */
const artifactCache = new Map();

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {string | null | undefined} path
 */
export function loadOptimizationArtifact(path = process.env[OPTIMIZATION_ARTIFACT_ENV]) {
    if (!path) {
        return null;
    }
    const resolved = resolve(path);
    if (!existsSync(resolved)) {
        throw new SmithersError("INVALID_INPUT", `Optimization artifact not found: ${path}`, { path });
    }
    const stat = statSync(resolved);
    const cached = artifactCache.get(resolved);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
        return cached.artifact;
    }
    const artifact = JSON.parse(readFileSync(resolved, "utf8"));
    if (!isObject(artifact)) {
        throw new SmithersError("INVALID_INPUT", "Optimization artifact must be a JSON object.", { path: resolved });
    }
    artifactCache.set(resolved, { mtimeMs: stat.mtimeMs, artifact });
    return artifact;
}

/**
 * @param {unknown} artifact
 * @returns {Record<string, { prompt?: string }>}
 */
function promptPatchesFromArtifact(artifact) {
    if (!isObject(artifact)) {
        return {};
    }
    if (isObject(artifact.promptPatches)) {
        return /** @type {Record<string, { prompt?: string }>} */ (artifact.promptPatches);
    }
    if (isObject(artifact.patches)) {
        return /** @type {Record<string, { prompt?: string }>} */ (artifact.patches);
    }
    return {};
}

/**
 * @param {import("@smithers-orchestrator/graph/TaskDescriptor").TaskDescriptor[]} tasks
 * @param {unknown} [artifact]
 */
export function applyOptimizationArtifactToTasks(tasks, artifact = loadOptimizationArtifact()) {
    if (!artifact) {
        return tasks;
    }
    const promptPatches = promptPatchesFromArtifact(artifact);
    if (Object.keys(promptPatches).length === 0) {
        return tasks;
    }
    return tasks.map((task) => {
        const patch = promptPatches[task.nodeId];
        if (!patch || typeof patch.prompt !== "string" || !task.agent) {
            return task;
        }
        return {
            ...task,
            prompt: patch.prompt,
            meta: {
                ...(task.meta ?? {}),
                optimizationArtifactId: typeof artifact.id === "string" ? artifact.id : undefined,
                optimizationStrategy: typeof artifact.strategy === "string" ? artifact.strategy : undefined,
            },
        };
    });
}

export { OPTIMIZATION_ARTIFACT_ENV };

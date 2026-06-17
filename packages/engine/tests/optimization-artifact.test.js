import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    OPTIMIZATION_ARTIFACT_ENV,
    applyOptimizationArtifactToTasks,
    loadOptimizationArtifact,
} from "../src/optimization-artifact.js";

function makeTempDir() {
    return mkdtempSync(join(tmpdir(), "smithers-optimization-artifact-"));
}

describe("optimization artifacts", () => {
    const originalEnv = process.env[OPTIMIZATION_ARTIFACT_ENV];
    const tempDirs = [];

    afterEach(() => {
        if (originalEnv === undefined) {
            delete process.env[OPTIMIZATION_ARTIFACT_ENV];
        }
        else {
            process.env[OPTIMIZATION_ARTIFACT_ENV] = originalEnv;
        }
        for (const dir of tempDirs.splice(0)) {
            if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
        }
    });

    test("loads a JSON object from an explicit path and caches unchanged artifacts", () => {
        const dir = makeTempDir();
        tempDirs.push(dir);
        const file = join(dir, "artifact.json");
        writeFileSync(file, JSON.stringify({ id: "artifact-1", promptPatches: {} }));

        const first = loadOptimizationArtifact(file);
        const second = loadOptimizationArtifact(file);

        expect(first).toEqual({ id: "artifact-1", promptPatches: {} });
        expect(second).toBe(first);
    });

    test("uses the environment path, handles empty input and rejects missing or non-object artifacts", () => {
        const dir = makeTempDir();
        tempDirs.push(dir);
        const file = join(dir, "artifact.json");
        writeFileSync(file, JSON.stringify({ id: "from-env" }));
        process.env[OPTIMIZATION_ARTIFACT_ENV] = file;

        expect(loadOptimizationArtifact()).toEqual({ id: "from-env" });
        expect(loadOptimizationArtifact("")).toBe(null);
        expect(() => loadOptimizationArtifact(join(dir, "missing.json"))).toThrow("Optimization artifact not found");

        const arrayFile = join(dir, "array.json");
        writeFileSync(arrayFile, JSON.stringify([]));
        expect(() => loadOptimizationArtifact(arrayFile)).toThrow("Optimization artifact must be a JSON object");
    });

    test("applies prompt patches only to agent tasks and preserves unpatched task identity", () => {
        const agentTask = {
            nodeId: "agent",
            agent: { id: "codex" },
            prompt: "old prompt",
            meta: { keep: true },
        };
        const computeTask = {
            nodeId: "compute",
            prompt: "compute prompt",
        };
        const untouchedAgentTask = {
            nodeId: "untouched",
            agent: { id: "codex" },
            prompt: "same",
        };

        const tasks = [agentTask, computeTask, untouchedAgentTask];
        const patched = applyOptimizationArtifactToTasks(tasks, {
            id: "artifact-1",
            strategy: "gepa",
            patches: {
                agent: { prompt: "new prompt" },
                compute: { prompt: "should not apply" },
                untouched: { prompt: 42 },
            },
        });

        expect(patched).not.toBe(tasks);
        expect(patched[0]).toEqual({
            nodeId: "agent",
            agent: { id: "codex" },
            prompt: "new prompt",
            meta: {
                keep: true,
                optimizationArtifactId: "artifact-1",
                optimizationStrategy: "gepa",
            },
        });
        expect(patched[1]).toBe(computeTask);
        expect(patched[2]).toBe(untouchedAgentTask);
        expect(applyOptimizationArtifactToTasks(tasks, null)).toBe(tasks);
        expect(applyOptimizationArtifactToTasks(tasks, { promptPatches: [] })).toBe(tasks);
    });

    test("uses promptPatches before legacy patches when both are present", () => {
        const agentTask = {
            nodeId: "agent",
            agent: { id: "codex" },
            prompt: "old prompt",
        };

        const patched = applyOptimizationArtifactToTasks([agentTask], {
            id: "artifact-2",
            strategy: "dspy",
            promptPatches: {
                agent: { prompt: "promptPatches prompt" },
            },
            patches: {
                agent: { prompt: "legacy patches prompt" },
            },
        });

        expect(patched[0]).toEqual({
            nodeId: "agent",
            agent: { id: "codex" },
            prompt: "promptPatches prompt",
            meta: {
                optimizationArtifactId: "artifact-2",
                optimizationStrategy: "dspy",
            },
        });
    });
});

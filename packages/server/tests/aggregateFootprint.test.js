import { describe, expect, test } from "bun:test";
import { aggregateFootprint } from "../src/gatewayRoutes/aggregateFootprint.js";
import { summarizeBundle } from "../src/gatewayRoutes/getNodeDiff.js";

describe("aggregateFootprint", () => {
    test("fixture DiffBundle patches roll up to correct totals without exposing patch text", () => {
        // Real unified-diff patch text, summarized by the production
        // summarizeBundle before aggregation — the same chain the route runs.
        const firstBundle = {
            patches: [
                { path: "src/a.ts", diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@\n context\n-const removed = 1;\n+const added = 1;\n+const another = 2;\n tail\n" },
                { path: "README.md", diff: "--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n # Title\n+New docs line\n" },
            ],
        };
        const secondBundle = {
            patches: [
                { path: "src/a.ts", diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,4 +1,6 @@\n context\n-old\n-old2\n+x\n+y\n+z\n tail\n" },
            ],
        };

        const result = aggregateFootprint([
            { nodeId: "implement", iteration: 0, summary: summarizeBundle(firstBundle) },
            { nodeId: "refactor", iteration: 1, summary: summarizeBundle(secondBundle) },
        ]);

        expect(result).toMatchObject({ filesChanged: 2, totalDirectories: 2, added: 6, removed: 3 });
        expect(result.files).toEqual([
            { path: "src/a.ts", added: 5, removed: 3, nodesTouched: 2, owner: { nodeId: "refactor", iteration: 1 } },
            { path: "README.md", added: 1, removed: 0, nodesTouched: 1, owner: { nodeId: "implement", iteration: 0 } },
        ]);
        expect(result.directories).toEqual([
            { path: "src", files: 1, added: 5, removed: 3 },
            { path: ".", files: 1, added: 1, removed: 0 },
        ]);

        const serialized = JSON.stringify(result);
        for (const leak of ["diff --git", "@@", "+++", "const removed", "const added", "New docs line", "old2"]) {
            expect(serialized).not.toContain(leak);
        }
    });

    test("sums file stats, attributes the largest owner, and rolls up directories", () => {
        const result = aggregateFootprint([
            { nodeId: "first", iteration: 0, summary: { files: [{ path: "src/a.ts", added: 2, removed: 1 }, { path: "README.md", added: 1, removed: 0 }] } },
            { nodeId: "second", iteration: 2, summary: { files: [{ path: "src/a.ts", added: 5, removed: 2 }, { path: "lib/b.ts", added: 4, removed: 0 }] } },
        ]);

        expect(result).toMatchObject({ filesChanged: 3, totalFiles: 3, totalDirectories: 3, added: 12, removed: 3 });
        expect(result.files.find((file) => file.path === "src/a.ts")).toMatchObject({
            added: 7, removed: 3, nodesTouched: 2, owner: { nodeId: "second", iteration: 2 },
        });
        expect(result.directories).toEqual([
            { path: "src", files: 1, added: 7, removed: 3 },
            { path: "lib", files: 1, added: 4, removed: 0 },
            { path: ".", files: 1, added: 1, removed: 0 },
        ]);
        expect(result.hottestDirectory).toEqual({ path: "src", files: 1, added: 7, removed: 3 });
    });

    test("retains stable equal-churn ordering and preserves full directory totals when capped", () => {
        const result = aggregateFootprint([
            { nodeId: "n", iteration: 0, summary: { files: [
                { path: "z.ts", added: 2, removed: 0 },
                { path: "a.ts", added: 2, removed: 0 },
                { path: "src/one.ts", added: 1, removed: 0 },
                { path: "src/two.ts", added: 1, removed: 0 },
            ] } },
        ], { topN: 1 });

        expect(result.files).toEqual([expect.objectContaining({ path: "z.ts" })]);
        expect(result.truncated).toBe(true);
        expect(result.directories.find((directory) => directory.path === "src")).toEqual({ path: "src", files: 2, added: 2, removed: 0 });
    });

    test("returns zero totals for empty or malformed entries", () => {
        const result = aggregateFootprint([null, { nodeId: "x", iteration: 0 }, { nodeId: "x", iteration: "0", summary: { files: [] } }]);
        expect(result).toEqual({
            filesChanged: 0,
            totalFiles: 0,
            totalDirectories: 0,
            added: 0,
            removed: 0,
            directories: [],
            files: [],
            hottestDirectory: null,
            truncated: false,
        });
    });
});

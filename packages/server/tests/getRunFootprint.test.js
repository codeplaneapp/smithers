import { describe, expect, test } from "bun:test";
import { getRunFootprintRoute } from "../src/gatewayRoutes/getRunFootprint.js";

const settled = (nodeId, iteration = 0, attempt = 1, pointer = `${nodeId}-${attempt}`) => ({
    nodeId, iteration, attempt, state: "finished", jjPointer: pointer,
});
const resolveWith = (attempts, extra = {}) => async () => ({ adapter: { listAttemptsForRun: async () => attempts }, ...extra });
const summaryFor = (nodeId) => ({ files: [{ path: `${nodeId}.ts`, added: 2, removed: 1 }] });

describe("getRunFootprintRoute", () => {
    test("rejects invalid and unknown runs", async () => {
        await expect(getRunFootprintRoute({ runId: "bad/id", resolveRun: async () => null })).rejects.toMatchObject({ code: "InvalidRunId" });
        await expect(getRunFootprintRoute({ runId: "missing", resolveRun: async () => null })).rejects.toMatchObject({ code: "RunNotFound" });
    });

    test("returns an empty footprint for in-progress attempts", async () => {
        const result = await getRunFootprintRoute({
            runId: "footprint-progress",
            resolveRun: resolveWith([{ ...settled("work"), state: "in-progress", jjPointer: null }]),
            getNodeDiffRouteImpl: async () => { throw new Error("must not diff"); },
        });
        expect(result).toMatchObject({ filesChanged: 0, totalFiles: 0, skippedNodes: 0 });
    });

    test("aggregates settled nodes and isolates failed stats", async () => {
        const attempts = [settled("one"), settled("two", 1)];
        const result = await getRunFootprintRoute({
            runId: "footprint-aggregate",
            resolveRun: resolveWith(attempts),
            getNodeDiffRouteImpl: async ({ nodeId, stat }) => {
                expect(stat).toBe(true);
                return nodeId === "two"
                    ? { ok: false, error: { code: "VcsError" } }
                    : { ok: true, payload: { summary: summaryFor(nodeId) } };
            },
        });
        expect(result).toMatchObject({ filesChanged: 1, skippedNodes: 1 });
        expect(result.files[0].path).toBe("one.ts");
    });

    test("keeps equal-churn results in recorded order when diff reads finish out of order", async () => {
        const releaseFirst = Promise.withResolvers();
        const options = {
            runId: "footprint-stable-order",
            resolveRun: resolveWith([settled("first"), settled("second")]),
            getNodeDiffRouteImpl: async ({ nodeId }) => {
                if (nodeId === "first") await releaseFirst.promise;
                else releaseFirst.resolve();
                return { ok: true, payload: { summary: summaryFor(nodeId) } };
            },
        };
        const result = await getRunFootprintRoute(options);
        expect(result.files.map((file) => file.path)).toEqual(["first.ts", "second.ts"]);
    });

    test("only computes new settled nodes and serves unchanged state from the run memo", async () => {
        const attempts = [settled("one")];
        let calls = 0;
        const diff = async ({ nodeId }) => {
            calls += 1;
            return { ok: true, payload: { summary: summaryFor(nodeId) } };
        };
        const options = { runId: "footprint-incremental", resolveRun: resolveWith(attempts), getNodeDiffRouteImpl: diff };
        await getRunFootprintRoute(options);
        expect(calls).toBe(1);
        await getRunFootprintRoute(options);
        expect(calls).toBe(1);
        attempts.push(settled("two"));
        await getRunFootprintRoute(options);
        expect(calls).toBe(2);
    });

    test("a snake_case retry busts freshness and recomputes its changed pointer", async () => {
        const attempts = [{ node_id: "one", iteration: 0, attempt_number: 1, state: "finished", jj_pointer: "first" }];
        let calls = 0;
        const options = {
            runId: "footprint-retry",
            resolveRun: resolveWith(attempts),
            getNodeDiffRouteImpl: async ({ nodeId }) => ({ ok: true, payload: { summary: summaryFor(`${nodeId}-${++calls}`) } }),
        };
        await getRunFootprintRoute(options);
        attempts.push({ node_id: "one", iteration: 0, attempt_number: 2, state: "finished", jj_pointer: "second" });
        const result = await getRunFootprintRoute(options);
        expect(calls).toBe(2);
        expect(result.files[0].path).toBe("one-2.ts");
    });
});

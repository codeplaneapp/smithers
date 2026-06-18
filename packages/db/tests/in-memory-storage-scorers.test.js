import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeInMemoryStorageService } from "../src/storage/InMemoryStorage.js";

describe("InMemoryStorage scorer results", () => {
    test("round-trips scorer context and groundTruth JSON", async () => {
        const storage = makeInMemoryStorageService();
        await Effect.runPromise(storage.insertScorerResult({
            id: "score-1",
            runId: "run-1",
            nodeId: "node-1",
            scorerId: "accuracy",
            groundTruthJson: JSON.stringify({ expected: "answer" }),
            contextJson: JSON.stringify({ docs: ["source"] }),
            scoredAtMs: 1000,
        }));

        const rows = await Effect.runPromise(storage.listScorerResults("run-1", "node-1"));
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0].groundTruthJson)).toEqual({ expected: "answer" });
        expect(JSON.parse(rows[0].contextJson)).toEqual({ docs: ["source"] });
    });
});

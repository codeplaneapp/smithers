import { smithersScorers } from "../index.js";

type InsertScorer = typeof smithersScorers.$inferInsert;
type SelectScorer = typeof smithersScorers.$inferSelect;

const insertRow: InsertScorer = {
    id: "score-1",
    runId: "run-1",
    nodeId: "node-1",
    scorerId: "accuracy",
    scorerName: "Accuracy",
    source: "batch",
    score: 0.95,
    scoredAtMs: 1_700_000_000_000,
};

const selectRow: SelectScorer = {
    id: "score-1",
    runId: "run-1",
    nodeId: "node-1",
    iteration: 0,
    attempt: 0,
    scorerId: "accuracy",
    scorerName: "Accuracy",
    source: "batch",
    score: 0.95,
    reason: null,
    metaJson: null,
    inputJson: null,
    outputJson: null,
    groundTruthJson: null,
    contextJson: null,
    latencyMs: null,
    scoredAtMs: 1_700_000_000_000,
    durationMs: null,
};

selectRow.score satisfies number;
selectRow.runId satisfies string;
selectRow.reason satisfies string | null;

// @ts-expect-error score must remain typed as a number, not erased to any.
insertRow.score = "0.95";

// @ts-expect-error runId must remain typed as a string, not erased to any.
insertRow.runId = 123;

// @ts-expect-error unknown columns must not be accepted.
insertRow.unknownColumn = "nope";

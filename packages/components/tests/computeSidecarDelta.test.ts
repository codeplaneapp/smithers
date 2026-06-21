import { describe, expect, test } from "bun:test";
import { computeSidecarDelta } from "../src/components/computeSidecarDelta.ts";

describe("computeSidecarDelta", () => {
	test("returns primary, sidecar, delta, and cheaperWins from persisted rows", () => {
		const rows = [
			{ nodeId: "answer", scorerId: "quality", score: 0.9, scoredAtMs: 1 },
			{ nodeId: "answer-sidecar", scorerId: "quality", score: 0.7, scoredAtMs: 2 },
			{ nodeId: "answer", scorerId: "other", score: 0.1, scoredAtMs: 3 },
		];
		expect(
			computeSidecarDelta(rows, {
				primaryNodeId: "answer",
				sidecarNodeId: "answer-sidecar",
				scorerId: "quality",
			}),
		).toEqual({
			primaryScore: 0.9,
			sidecarScore: 0.7,
			delta: 0.2,
			cheaperWins: false,
		});
	});

	test("marks cheaperWins when sidecar score is at least the primary score", () => {
		const rows = [
			{ node_id: "answer", scorer_id: "quality", score: 0.8, scored_at_ms: 1 },
			{ node_id: "answer-sidecar", scorer_id: "quality", score: 0.8, scored_at_ms: 2 },
		];
		const result = computeSidecarDelta(rows, {
			primaryNodeId: "answer",
			sidecarNodeId: "answer-sidecar",
			scorerId: "quality",
		});
		expect(result.cheaperWins).toBe(true);
		expect(result.delta).toBe(0);
	});
});

import { describe, expect, test } from "bun:test";
import { filterFleetHealth } from "./fleet-health.ts";

/** Minimal ps-row factory; only the fields the filter reads are required. */
function row(over: {
	status: string;
	ageMinutes?: number;
	finishedAgeMinutes?: number | null;
	runId?: string;
}) {
	return {
		project: "demo",
		runId: over.runId ?? "run-x",
		lastEvent: null,
		status: over.status,
		ageMinutes: over.ageMinutes ?? 0,
		finishedAgeMinutes: over.finishedAgeMinutes ?? null,
	};
}

describe("filterFleetHealth", () => {
	test("drops settled history (finished / cancelled) regardless of age", () => {
		const kept = filterFleetHealth([
			row({ status: "finished", ageMinutes: 2 }),
			row({ status: "cancelled", ageMinutes: 2 }),
		]);
		expect(kept).toEqual([]);
	});

	test("keeps a run that failed recently (5m since failure)", () => {
		const kept = filterFleetHealth([row({ status: "failed", ageMinutes: 5, finishedAgeMinutes: 5 })]);
		expect(kept).toHaveLength(1);
	});

	test("keeps a long run that failed a minute ago even though it started 2h ago", () => {
		// The regression this guards: freshness is time-since-FAILURE, not
		// time-since-start. A 2h agent run that died 1m ago is the most
		// expensive fresh failure and must still be escalated.
		const kept = filterFleetHealth([
			row({ status: "failed", ageMinutes: 120, finishedAgeMinutes: 1 }),
		]);
		expect(kept).toHaveLength(1);
	});

	test("drops a failure that finished over an hour ago", () => {
		const kept = filterFleetHealth([
			row({ status: "failed", ageMinutes: 200, finishedAgeMinutes: 90 }),
		]);
		expect(kept).toEqual([]);
	});

	test("falls back to start-age when finish time is absent", () => {
		const kept = filterFleetHealth([
			row({ status: "failed", ageMinutes: 5, finishedAgeMinutes: null }),
			row({ status: "failed", ageMinutes: 120, finishedAgeMinutes: null }),
		]);
		expect(kept).toHaveLength(1);
		expect(kept[0].ageMinutes).toBe(5);
	});

	test("keeps running / continued / orphaned / unknown runs regardless of age", () => {
		const kept = filterFleetHealth([
			row({ status: "running", ageMinutes: 999 }),
			row({ status: "continued", ageMinutes: 999 }),
			row({ status: "orphaned", ageMinutes: 999 }),
			row({ status: "unknown", ageMinutes: 999 }),
		]);
		expect(kept).toHaveLength(4);
	});
});

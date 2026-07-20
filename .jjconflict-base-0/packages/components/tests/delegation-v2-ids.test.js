import { describe, expect, test } from "bun:test";
import {
	canonicalJson,
	hashStableValue,
	invocationOutcomeNodeId,
	isGatewaySafeNodeId,
	programNodeId,
	turnNodeId,
} from "../src/components/delegation-v2/delegationV2Ids.js";

describe("delegation v2 canonical identity", () => {
	test("canonicalizes object key order but preserves semantic array order", () => {
		expect(canonicalJson({ z: 1, a: { y: true, x: null } })).toBe('{"a":{"x":null,"y":true},"z":1}');
		expect(hashStableValue({ a: 1, b: [2, 3] })).toBe(hashStableValue({ b: [2, 3], a: 1 }));
		expect(hashStableValue({ a: [2, 3] })).not.toBe(hashStableValue({ a: [3, 2] }));
		expect(hashStableValue(-0)).toBe(hashStableValue(0));
	});

	test("rejects values outside the canonical JSON data model", () => {
		expect(() => canonicalJson({ missing: undefined })).toThrow(/cannot encode undefined/);
		expect(() => canonicalJson(new Date())).toThrow(/plain objects/);
		const sparse = Array(2);
		expect(() => canonicalJson(sparse)).toThrow(/sparse arrays/);
		const cycle = {};
		cycle.self = cycle;
		expect(() => canonicalJson(cycle)).toThrow(/cyclic/);
	});

	test("derives deterministic Trellis IDs within gateway limits", () => {
		const digest = hashStableValue({ schemaVersion: 1, id: "program" });
		const turn = turnNodeId({ invocationKey: "root/author/with unsafe spaces", generation: 2, phase: "author" });
		const node = programNodeId({
			invocationKey: "root/author/with unsafe spaces".repeat(20),
			generation: 2,
			programDigest: digest,
			localId: "research-one",
			phase: "raw",
		});
		const outcome = invocationOutcomeNodeId({ invocationKey: "root/author/with unsafe spaces" });
		for (const id of [turn, node, outcome]) {
			expect(id.startsWith("trellis:")).toBe(true);
			expect(isGatewaySafeNodeId(id)).toBe(true);
			expect(id.length).toBeLessThanOrEqual(128);
		}
		expect(turn).toBe(turnNodeId({ invocationKey: "root/author/with unsafe spaces", generation: 2, phase: "author" }));
	});

	test("changes IDs when prompt/program identity changes, not when unrelated siblings reorder", () => {
		const digestA = hashStableValue({ prompt: "A" });
		const digestB = hashStableValue({ prompt: "B" });
		const base = { invocationKey: "root", generation: 0, localId: "worker", phase: "raw" };
		const first = programNodeId({ ...base, programDigest: digestA });
		expect(programNodeId({ ...base, programDigest: digestA })).toBe(first);
		expect(programNodeId({ ...base, programDigest: digestB })).not.toBe(first);
		expect(programNodeId({ ...base, localId: "other", programDigest: digestA })).not.toBe(first);
	});

	test("rejects malformed trusted identity inputs", () => {
		expect(() => turnNodeId({ invocationKey: "root", generation: -1, phase: "author" })).toThrow(/generation/);
		expect(() => programNodeId({ invocationKey: "root", generation: 0, programDigest: "not-a-digest", localId: "worker", phase: "raw" })).toThrow(/programDigest/);
		expect(() => invocationOutcomeNodeId({ prefix: "bad:prefix", invocationKey: "root" })).toThrow(/prefix/);
	});
});

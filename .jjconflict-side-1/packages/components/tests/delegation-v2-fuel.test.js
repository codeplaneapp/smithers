import { describe, expect, test } from "bun:test";
import {
	enforceDelegationV2AuthorFuel,
	partitionDelegationV2AuthorFuel,
} from "../src/components/delegation-v2/delegationV2Fuel.js";

describe("delegation v2 global author fuel", () => {
	test("partitions one immutable budget without duplication and independent of sibling order", () => {
		const left = partitionDelegationV2AuthorFuel({
			nestedLogicalIds: ["zeta", "alpha", "middle"],
			remainingTurns: 11,
			parentCapacity: 8,
		});
		const reordered = partitionDelegationV2AuthorFuel({
			nestedLogicalIds: ["middle", "zeta", "alpha"],
			remainingTurns: 11,
			parentCapacity: 8,
		});
		expect(reordered).toEqual(left);
		expect(left.allocatedTurns).toBe(11);
		expect(left.parentTurns).toBeGreaterThan(0);
		expect(Object.values(left.childTurns).every((turns) => turns > 0)).toBe(true);
	});

	test("rejects accepted graph growth that cannot fund children and continuation", () => {
		const accepted = {
			ok: true,
			status: "accepted",
			normalizedProgram: { id: "program" },
			diagnostics: [],
			stats: { authors: 2 },
		};
		const rejected = enforceDelegationV2AuthorFuel(accepted, 2);
		expect(rejected.ok).toBe(false);
		expect(rejected.normalizedProgram).toBeUndefined();
		expect(rejected.diagnostics[0].code).toBe("author_fuel_limit");
		expect(enforceDelegationV2AuthorFuel(accepted, 3)).toBe(accepted);
	});
});

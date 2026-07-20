import { describe, expect, test } from "bun:test";
import {
  buildDelegationV2EvidencePacket,
  collectDelegationV2Outcomes,
  delegationV2RowForNode,
} from "../src/components/delegation-v2/delegationV2State.js";

describe("delegation v2 state helpers", () => {
  test("looks up immutable physical ids without conflating logical generations", () => {
    const rows = [
      { nodeId: "trellis:a:g0", logicalId: "same", iteration: 0, value: "old" },
      { nodeId: "trellis:a:g1@@2", logicalId: "same", iteration: 2, value: "new" },
    ];
    expect(delegationV2RowForNode(rows, "trellis:a:g0")?.value).toBe("old");
    expect(delegationV2RowForNode(rows, "trellis:a:g1")?.value).toBeUndefined();
    expect(delegationV2RowForNode(rows, "trellis:a:g1", { _currentScopes: new Set(["@@2"]) })?.value).toBe("new");
  });

  test("collects declared outputs in declaration order", () => {
    const rows = [
      { nodeId: "out:b", logicalId: "b" },
      { nodeId: "out:a", logicalId: "a" },
    ];
    const result = collectDelegationV2Outcomes(rows, ["out:a", "out:b"]);
    expect(result.settled).toBe(true);
    expect(result.rows.map((row) => row.logicalId)).toEqual(["a", "b"]);
  });

  test("reports missing outputs and bounds continuation context", () => {
    const result = collectDelegationV2Outcomes([{ nodeId: "out:a" }], ["out:a", "out:b"]);
    expect(result).toMatchObject({ settled: false, missing: ["out:b"] });

    const packet = buildDelegationV2EvidencePacket([
      { nodeId: "out:a", logicalId: "a", status: "complete", product: { summary: "x".repeat(100) } },
    ], 32);
    expect(packet).toMatchObject({ truncated: true, originalItems: 1 });
  });
});

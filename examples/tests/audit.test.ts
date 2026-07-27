import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers audit", async () => {
  const result = await coverExample("../audit.jsx", {
    input: { directory: ".", auditType: "security" },
    mocks: {
      scan: {
        items: [
          { id: "critical", category: "security", severity: "critical", description: "a", location: "a.ts" },
          { id: "high", category: "security", severity: "high", description: "b", location: "b.ts" },
          { id: "medium", category: "quality", severity: "medium", description: "c", location: "c.ts" },
        ],
        totalScanned: 3,
      },
      "investigate-critical": {
        itemId: "critical", status: "confirmed", details: "real", recommendation: "fix it",
      },
      "investigate-high": {
        itemId: "high", status: "false-positive", details: "safe", recommendation: "none",
      },
    },
  });

  expect(result.executed).toEqual(["scan", "investigate-critical", "investigate-high", "report"]);
  expect(result.taskOutputs.report[0]).toMatchObject({
    totalItems: 3,
    critical: 1,
    high: 1,
    medium: 1,
    falsePositives: 1,
    recommendations: ["fix it"],
  });
});

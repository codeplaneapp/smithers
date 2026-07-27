import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers compliance-evidence-collector", async () => {
  const result = await coverExample("../compliance-evidence-collector.jsx", {
    input: { framework: "SOC2" },
    mocks: {
      plan: {
        controls: [{
          controlId: "CC1", description: "Access",
          sources: [
            { sourceId: "iam", endpoint: "/iam", preferredMethod: "api" },
            { sourceId: "logs", endpoint: "/logs", preferredMethod: "mcp" },
          ],
        }],
        totalSources: 2,
      },
      "fetch-*": ({ nodeId }: { nodeId: string }) => {
        const sourceId = nodeId.endsWith("iam") ? "iam" : "logs";
        return {
          sourceId, controlId: "CC1", title: sourceId, rawPayload: "{}",
          fetchedAt: "now", method: sourceId === "iam" ? "api" : "mcp", status: "collected",
        };
      },
      "normalize-*": ({ nodeId }: { nodeId: string }) => ({
        controlId: "CC1", sourceId: nodeId.endsWith("iam") ? "iam" : "logs",
        finding: "present", compliant: true, severity: "info",
      }),
      packet: {
        framework: "SOC2", generatedAt: "now", controlCount: 1, compliantCount: 1,
        nonCompliantCount: 0,
        findings: [{ controlId: "CC1", status: "compliant", evidence: ["iam", "logs"] }],
        summary: "compliant",
      },
    },
  });

  expect(result.executed).toEqual([
    "plan", "fetch-CC1-iam", "fetch-CC1-logs",
    "normalize-CC1-iam", "normalize-CC1-logs", "packet",
  ]);
  expect(result.taskOutputs["normalize-CC1-iam"][0]).toMatchObject({ sourceId: "iam", compliant: true });
  expect(result.taskOutputs.packet[0]).toMatchObject({ controlCount: 1, compliantCount: 1 });
});

import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const Prompt = () => "test prompt";
for (const name of ["ingest", "external-enrich", "internal-enrich", "analyst", "case"]) {
  mock.module(`../prompts/threat-intel-enricher/${name}.mdx`, () => ({ default: Prompt }));
}

test("covers threat-intel-enricher", async () => {
  const result = await coverExample("../threat-intel-enricher.jsx", {
    mocks: {
      ingest: {
        alertId: "a1", source: "siem", indicators: [{ type: "ip", value: "127.0.0.1" }],
        rawDescription: "probe", timestamp: "now", summary: "alert",
      },
      "external-enrich": { indicators: [], cveMatches: [], summary: "external" },
      "internal-enrich": {
        affectedAssets: [], recentActivity: [], priorIncidents: [], summary: "internal",
      },
      analyst: {
        severity: "high", confidence: 0.9, attackVector: "network",
        firstActions: ["block"], narrative: "malicious", summary: "verdict",
      },
      case: {
        caseId: "c1", severity: "high", title: "Alert a1", assignee: "soc",
        firstActions: ["block"], enrichmentSummary: "enriched", status: "open", summary: "filed",
      },
    },
  });

  expect(result.executed).toEqual([
    "ingest", "external-enrich", "internal-enrich", "analyst", "case",
  ]);
  expect(result.taskOutputs.case[0]).toMatchObject({
    caseId: "c1", severity: "high", firstActions: ["block"], status: "open",
  });
});

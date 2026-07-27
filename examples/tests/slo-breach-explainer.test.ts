import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const Prompt = () => "test prompt";
for (const name of ["trigger", "traces", "logs", "changes", "synthesis"]) {
  mock.module(`../prompts/slo-breach-explainer/${name}.mdx`, () => ({ default: Prompt }));
}

test("covers slo-breach-explainer", async () => {
  const result = await coverExample("../slo-breach-explainer.jsx", {
    input: {
      service: "api", sloName: "error-rate", threshold: "1%",
      observed: "10%", window: "2026-07-27T00:00Z/PT1H",
    },
    mocks: {
      trigger: {
        service: "api", sloName: "error-rate", threshold: "1%",
        observed: "10%", window: "2026-07-27T00:00Z/PT1H",
      },
      traces: { topSpans: [], bottleneck: "database", sampleTraceId: "trace-1" },
      logs: { errorCount: 100, topErrors: [], anomalies: ["timeouts"] },
      changes: { recentDeploys: [], configChanges: [], suspectChange: "pool size" },
      incidentNote: {
        title: "API errors", severity: "high", causalChain: ["pool changed", "timeouts"],
        rootCause: "pool size", impactSummary: "requests failed", mitigation: "restore pool",
        followUps: ["add alert"], summary: "Pool change caused timeouts.",
      },
    },
    expectedNodes: ["trigger", "traces", "logs", "changes", "incidentNote"],
  });

  expect(result.executed).toEqual(["trigger", "traces", "logs", "changes", "incidentNote"]);
  expect(result.taskOutputs.incidentNote[0]).toMatchObject({ severity: "high", rootCause: "pool size" });
}, 15_000);

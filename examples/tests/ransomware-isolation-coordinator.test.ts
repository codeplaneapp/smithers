import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const mocks = {
  detect: { hostId: "host-1", indicators: ["encrypted files"], severity: "critical", isolateRecommended: true },
  contain: {
    hostId: "host-1", networkIsolated: true, evidenceSnapshotUrl: "s3://evidence",
    notifiedChannels: ["incident"],
  },
  report: {
    incidentId: "inc-1", timeline: ["detected", "contained"],
    containmentStatus: "contained", summary: "isolated",
  },
};

test("covers ransomware-isolation-coordinator approval paths", async () => {
  const approved = await coverExample("../ransomware-isolation-coordinator.jsx", {
    mocks, approvals: "approve",
    expectedNodes: ["detect", "approve-containment", "contain", "report"],
  });
  const denied = await coverExample("../ransomware-isolation-coordinator.jsx", {
    mocks, approvals: "deny", assert: false,
  });

  expect(approved.executed).toEqual(["detect", "approve-containment", "contain", "report"]);
  expect(approved.taskOutputs.contain[0]).toMatchObject({ networkIsolated: true });
  expect(denied.executed).toEqual(["detect", "approve-containment"]);
  expect(denied.approvals[0]).toMatchObject({ approved: false });
});

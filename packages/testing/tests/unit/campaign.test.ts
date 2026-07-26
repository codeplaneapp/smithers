import { describe, expect, test } from "bun:test";
import { runCampaign, type CampaignScenario } from "../../src/campaign.ts";

describe("runCampaign", () => {
  test("runs scenarios in order and stops on fail", async () => {
    const seen: string[] = [];
    const scenarios: CampaignScenario[] = [
      {
        id: "a",
        title: "ok",
        run: async () => {
          seen.push("a");
        },
      },
      {
        id: "b",
        title: "fail",
        run: async () => {
          seen.push("b");
          throw new Error("boom");
        },
      },
      {
        id: "c",
        title: "never",
        run: async () => {
          seen.push("c");
        },
      },
    ];
    const report = await runCampaign({
      scenarios,
      onFail: "stop",
      log: () => {},
    });
    expect(report.ok).toBe(false);
    expect(seen).toEqual(["a", "b"]);
    expect(report.results).toHaveLength(2);
    expect(report.results[1]?.error).toContain("boom");
  });

  test("continue records failures and finishes catalog", async () => {
    const scenarios: CampaignScenario[] = [
      {
        id: "a",
        title: "fail",
        run: async () => {
          throw new Error("x");
        },
      },
      { id: "b", title: "ok", run: async () => {} },
    ];
    const report = await runCampaign({
      scenarios,
      onFail: "continue",
      log: () => {},
    });
    expect(report.ok).toBe(false);
    expect(report.results).toHaveLength(2);
    expect(report.results[1]?.ok).toBe(true);
  });

  test("only filter", async () => {
    const seen: string[] = [];
    const scenarios: CampaignScenario[] = [
      {
        id: "a",
        title: "a",
        run: async () => {
          seen.push("a");
        },
      },
      {
        id: "b",
        title: "b",
        run: async () => {
          seen.push("b");
        },
      },
    ];
    await runCampaign({ scenarios, only: ["b"], log: () => {} });
    expect(seen).toEqual(["b"]);
  });

  test("requireHerdr fails when scenario reports herdr=false", async () => {
    const report = await runCampaign({
      scenarios: [
        {
          id: "a",
          title: "no mirror",
          run: async () => ({ runId: "r1", herdr: false }),
        },
      ],
      herdr: true,
      requireHerdr: true,
      log: () => {},
    });
    expect(report.ok).toBe(false);
    expect(report.results[0]?.error).toContain("herdr required");
  });

  test("onScenarioStart runs before each scenario", async () => {
    const order: string[] = [];
    await runCampaign({
      scenarios: [
        {
          id: "a",
          title: "a",
          run: async () => {
            order.push("run-a");
          },
        },
      ],
      onScenarioStart: async () => {
        order.push("start-a");
      },
      log: () => {},
    });
    expect(order).toEqual(["start-a", "run-a"]);
  });
});

import { isCampaignWorkspaceLabel } from "../../src/herdrBridge.ts";

describe("isCampaignWorkspaceLabel", () => {
  test("matches campaign fixtures", () => {
    expect(isCampaignWorkspaceLabel("core-hello camp-abc-hello-i0")).toBe(true);
    expect(isCampaignWorkspaceLabel("✓ core-sequence camp-x-sequence-i0")).toBe(true);
    expect(isCampaignWorkspaceLabel("✗ core-parallel camp-x-parallel-i0")).toBe(true);
    expect(isCampaignWorkspaceLabel("~")).toBe(false);
    expect(isCampaignWorkspaceLabel("✓ poem-loop2 run-123")).toBe(false);
  });
});

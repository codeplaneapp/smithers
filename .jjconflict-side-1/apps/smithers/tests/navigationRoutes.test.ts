import { describe, expect, test } from "bun:test";
import { surfaceToRoute } from "../src/app/navigation";
import { router } from "../src/app/router";

describe("run detail navigation routes", () => {
  test("live run list actions build canonical gateway-backed URLs", () => {
    expect(
      surfaceToRoute({
        kind: "gatewayRun",
        workflowKey: "implement",
        runId: "run_123",
      }),
    ).toEqual({
      to: "/gw/$workflowKey/$runId",
      params: { workflowKey: "implement", runId: "run_123" },
    });
    expect(
      surfaceToRoute({
        kind: "gatewayRun",
        workflowKey: "implement",
        runId: "run_123",
        view: "logs",
      }),
    ).toEqual({
      to: "/gw/$workflowKey/$runId/logs",
      params: { workflowKey: "implement", runId: "run_123" },
    });
    expect(
      surfaceToRoute({
        kind: "gatewayRun",
        workflowKey: "implement",
        runId: "run_123",
        view: "timeline",
      }),
    ).toEqual({
      to: "/gw/$workflowKey/$runId/timeline",
      params: { workflowKey: "implement", runId: "run_123" },
    });
  });

  test("legacy run surface actions normalize to gateway route targets", () => {
    expect(surfaceToRoute({ kind: "inspector", runId: "run_123" })).toEqual({
      to: "/gw/$workflowKey/$runId",
      params: { workflowKey: "run_123", runId: "run_123" },
    });
    expect(surfaceToRoute({ kind: "logs", runId: "run_123" })).toEqual({
      to: "/gw/$workflowKey/$runId/logs",
      params: { workflowKey: "run_123", runId: "run_123" },
    });
    expect(surfaceToRoute({ kind: "diff", runId: "run_123", diffId: "task@1" })).toEqual({
      to: "/gw/$workflowKey/$runId/diff/$diffId",
      params: { workflowKey: "run_123", runId: "run_123", diffId: "task@1" },
    });
    expect(surfaceToRoute({ kind: "timeline", runId: "run_123" })).toEqual({
      to: "/gw/$workflowKey/$runId/timeline",
      params: { workflowKey: "run_123", runId: "run_123" },
    });
  });

  test("router exposes gateway render routes and only redirect compatibility for legacy runs", () => {
    const paths = Object.keys(router.routesByPath);
    expect(paths).toContain("/gw/$workflowKey/$runId");
    expect(paths).toContain("/gw/$workflowKey/$runId/logs");
    expect(paths).toContain("/gw/$workflowKey/$runId/diff/$diffId");
    expect(paths).toContain("/gw/$workflowKey/$runId/tickets");
    expect(paths).toContain("/gw/$workflowKey/$runId/timeline");
    expect(paths).toContain("/runs/$runId");
    expect(paths).toContain("/runs/$runId/logs");
    expect(paths).toContain("/runs/$runId/diff/$diffId");
    expect(paths).toContain("/runs/$runId/tickets");
    expect(paths).toContain("/runs/$runId/timeline");
  });
});

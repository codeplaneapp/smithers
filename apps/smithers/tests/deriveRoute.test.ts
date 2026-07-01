import { describe, expect, test } from "bun:test";
import { deriveRoute } from "../src/app/deriveRoute";

/**
 * `deriveRoute` is the route store's only writer — the pure URL → state map.
 * These assertions pin the local-only surface set (cloud surfaces such as
 * terminal, issues, landings were stripped) and the canonical gateway-backed
 * run detail route model.
 */
describe("deriveRoute", () => {
  test("home + store views", () => {
    expect(deriveRoute("/", {})).toMatchObject({ view: "home", surface: null });
    expect(deriveRoute("/store", {})).toMatchObject({
      view: "store",
      surface: null,
    });
  });

  test("gateway run surfaces match longest-prefix first", () => {
    expect(deriveRoute("/gw/implement/run_1/logs", {}).surface).toEqual({
      kind: "gatewayRun",
      workflowKey: "implement",
      runId: "run_1",
      view: "logs",
    });
    expect(deriveRoute("/gw/implement/run_1/tickets", {}).surface).toEqual({
      kind: "gatewayRun",
      workflowKey: "implement",
      runId: "run_1",
      view: "tickets",
    });
    expect(deriveRoute("/gw/implement/run_1/timeline", {}).surface).toEqual({
      kind: "gatewayRun",
      workflowKey: "implement",
      runId: "run_1",
      view: "timeline",
    });
    expect(deriveRoute("/gw/implement/run_1/diff/task@2", {}).surface).toEqual({
      kind: "gatewayRun",
      workflowKey: "implement",
      runId: "run_1",
      view: "diff",
      diffId: "task@2",
    });
    expect(deriveRoute("/gw/implement/run_1", {}).surface).toEqual({
      kind: "gatewayRun",
      workflowKey: "implement",
      runId: "run_1",
      view: "inspector",
    });
  });

  test("legacy /runs deep links normalize to gateway run surfaces", () => {
    expect(deriveRoute("/runs/run_1/logs", {}).surface).toEqual({
      kind: "gatewayRun",
      workflowKey: "run_1",
      runId: "run_1",
      view: "logs",
    });
    expect(deriveRoute("/runs/run_1/tickets", {}).surface).toEqual({
      kind: "gatewayRun",
      workflowKey: "run_1",
      runId: "run_1",
      view: "tickets",
    });
    expect(deriveRoute("/runs/run_1/timeline", {}).surface).toEqual({
      kind: "gatewayRun",
      workflowKey: "run_1",
      runId: "run_1",
      view: "timeline",
    });
    expect(deriveRoute("/runs/run_1/diff/task@2", {}).surface).toEqual({
      kind: "gatewayRun",
      workflowKey: "run_1",
      runId: "run_1",
      view: "diff",
      diffId: "task@2",
    });
    expect(deriveRoute("/runs/run_1", {}).surface).toEqual({
      kind: "gatewayRun",
      workflowKey: "run_1",
      runId: "run_1",
      view: "inspector",
    });
  });

  test("legacy run links never derive fixture-backed local run surfaces", () => {
    for (const path of [
      "/runs/run_1",
      "/runs/run_1/logs",
      "/runs/run_1/diff/task",
      "/runs/run_1/timeline",
      "/runs/run_1/tickets",
    ]) {
      expect(deriveRoute(path, {}).surface).not.toMatchObject({
        kind: expect.stringMatching(/^(inspector|logs|diff|timeline)$/),
      });
    }
  });

  test("top-level local surfaces", () => {
    for (const [path, kind] of [
      ["/runs", "runs"],
      ["/approvals", "approvals"],
      ["/agents", "agents"],
      ["/memory", "memory"],
      ["/files", "files"],
      ["/vcs", "vcs"],
      ["/prompts", "prompts"],
      ["/scores", "scores"],
      ["/crons", "crons"],
      ["/tickets", "tickets"],
      ["/palette", "palette"],
    ] as const) {
      expect(deriveRoute(path, {}).surface).toEqual({ kind } as never);
    }
  });

  test("gateway run + workflow editor are parsed", () => {
    expect(deriveRoute("/gw/implement/run_1", {}).surface).toEqual({
      kind: "gatewayRun",
      workflowKey: "implement",
      runId: "run_1",
      view: "inspector",
    });
    expect(deriveRoute("/workflow/hello", {}).surface).toEqual({
      kind: "workflowEditor",
      id: "hello",
    });
  });

  test("malformed and encoded path segments are decoded defensively", () => {
    expect(deriveRoute("/gw/work%20flow/run%2F1/logs", {}).surface).toEqual({
      kind: "gatewayRun",
      workflowKey: "work flow",
      runId: "run/1",
      view: "logs",
    });
    expect(deriveRoute("/runs/%/timeline", {}).surface).toEqual({
      kind: "gatewayRun",
      workflowKey: "%",
      runId: "%",
      view: "timeline",
    });
  });

  test("stripped cloud surfaces fall through to notFound", () => {
    for (const path of [
      "/terminal",
      "/issues",
      "/landings",
      "/askme",
    ]) {
      expect(deriveRoute(path, {})).toMatchObject({
        view: "notFound",
        surface: null,
      });
    }
  });

  test("root search params are retained", () => {
    expect(deriveRoute("/runs", { project: "acme" }).project).toBe("acme");
    expect(
      deriveRoute("/runs", { workspace: "/tmp/local-app" }).workspaceRoot,
    ).toBe("/tmp/local-app");
  });
});

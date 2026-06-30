import { describe, expect, test } from "bun:test";
import { deriveRoute } from "../src/app/deriveRoute";

/**
 * `deriveRoute` is the route store's only writer — the pure URL → state map.
 * These assertions pin the local-only surface set (the cloud surfaces — vcs,
 * files, terminal, issues, landings — were stripped) and the run-scoped prefix
 * matching that mirrors the TanStack router's <Outlet>.
 */
describe("deriveRoute", () => {
  test("home + store views", () => {
    expect(deriveRoute("/", {})).toEqual({ view: "home", surface: null, project: undefined });
    expect(deriveRoute("/store", {})).toEqual({ view: "store", surface: null, project: undefined });
  });

  test("run surfaces match longest-prefix first", () => {
    expect(deriveRoute("/runs/abc/logs", {}).surface).toEqual({ kind: "logs", runId: "abc" });
    expect(deriveRoute("/runs/abc/timeline", {}).surface).toEqual({ kind: "timeline", runId: "abc" });
    expect(deriveRoute("/runs/abc/diff/d1", {}).surface).toEqual({
      kind: "diff",
      runId: "abc",
      diffId: "d1",
    });
    expect(deriveRoute("/runs/abc", {}).surface).toEqual({ kind: "inspector", runId: "abc" });
  });

  test("top-level local surfaces", () => {
    for (const [path, kind] of [
      ["/runs", "runs"],
      ["/approvals", "approvals"],
      ["/agents", "agents"],
      ["/memory", "memory"],
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
    });
    expect(deriveRoute("/workflow/hello", {}).surface).toEqual({ kind: "workflowEditor", id: "hello" });
  });

  test("stripped cloud surfaces fall through to notFound", () => {
    for (const path of ["/vcs", "/files", "/terminal", "/issues", "/landings", "/askme"]) {
      expect(deriveRoute(path, {})).toEqual({ view: "notFound", surface: null, project: undefined });
    }
  });

  test("project search param is retained", () => {
    expect(deriveRoute("/runs", { project: "acme" }).project).toBe("acme");
  });
});

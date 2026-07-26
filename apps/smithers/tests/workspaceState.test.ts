import { describe, expect, test } from "bun:test";
import {
  MAX_RECENT_WORKSPACES,
  applyWorkspaceReadiness,
  nextRecentWorkspaces,
  normalizeRecentWorkspaces,
  type LocalWorkspaceReadiness,
} from "../src/app/workspaceState";

function readiness(
  workspaceRoot: string,
  status: LocalWorkspaceReadiness["status"] = "ready",
): LocalWorkspaceReadiness {
  return {
    status,
    workspaceRoot,
    serverWorkspaceRoot: "/workspace/app",
    gatewayBase: "http://127.0.0.1:7331",
    gatewayReachable: true,
    gatewayStatus: 200,
    scopedToSelectedRoot: status === "ready",
    missing: status === "missing-setup" ? [".smithers/"] : [],
    message: status === "ready" ? "Local workspace is ready." : "Missing local Smithers setup: .smithers/.",
  };
}

describe("workspaceState", () => {
  test("normalizes recent local workspace roots", () => {
    const roots = normalizeRecentWorkspaces([
      " /a ",
      "/b",
      "/a",
      "",
      4,
      ...Array.from({ length: 12 }, (_, i) => `/r${i}`),
    ]);
    expect(roots[0]).toBe("/a");
    expect(roots[1]).toBe("/b");
    expect(roots).toHaveLength(MAX_RECENT_WORKSPACES);
  });

  test("dedupes selected workspace to the front", () => {
    expect(nextRecentWorkspaces(["/old", "/app"], "/app")).toEqual(["/app", "/old"]);
  });

  test("ready readiness selects the workspace and records it as recent", () => {
    const state = applyWorkspaceReadiness({ recentWorkspaces: ["/old"] }, readiness("/workspace/app"));

    expect(state.status).toBe("ready");
    expect(state.selectedWorkspaceRoot).toBe("/workspace/app");
    expect(state.recentWorkspaces).toEqual(["/workspace/app", "/old"]);
    expect(state.error).toBeNull();
  });

  test("failed readiness keeps recent workspaces unchanged and reports the local issue", () => {
    const state = applyWorkspaceReadiness({ recentWorkspaces: ["/old"] }, readiness("/workspace/app", "missing-setup"));

    expect(state.status).toBe("missing-setup");
    expect(state.selectedWorkspaceRoot).toBe("/workspace/app");
    expect(state.recentWorkspaces).toEqual(["/old"]);
    expect(state.error).toContain("Missing local Smithers setup");
  });
});

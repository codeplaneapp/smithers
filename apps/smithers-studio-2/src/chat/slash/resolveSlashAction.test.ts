import { describe, expect, test } from "bun:test";
import { resolveSlashAction } from "./resolveSlashAction";

describe("resolveSlashAction", () => {
  test("/runs opens the populated Runs dashboard overlay", () => {
    const action = resolveSlashAction({ name: "runs", args: "" });
    expect(action.kind).toBe("open-overlay");
    if (action.kind !== "open-overlay") throw new Error("expected overlay");
    expect(action.overlay).toEqual({ kind: "dashboard", title: "Runs", dashboard: "runs" });
    expect(action.presentation).toBe("split");
  });

  test("/pr builds a PR overlay from the number", () => {
    const action = resolveSlashAction({ name: "pr", args: "#128" });
    if (action.kind !== "open-overlay" || action.overlay.kind !== "pr") throw new Error("expected pr overlay");
    expect(action.overlay.pr.number).toBe(128);
    expect(action.overlay.title).toBe("PR #128");
  });

  test("/terminal opens the live terminal overlay", () => {
    const action = resolveSlashAction({ name: "terminal", args: "" });
    if (action.kind !== "open-overlay") throw new Error("expected overlay");
    expect(action.overlay.kind).toBe("terminal");
  });

  test("/web normalizes a bare host into an https iframe url", () => {
    const action = resolveSlashAction({ name: "web", args: "example.com" });
    if (action.kind !== "open-overlay" || action.overlay.kind !== "iframe") throw new Error("expected iframe");
    expect(action.overlay.url).toBe("https://example.com");
  });

  test("/prompt is handed to the agent", () => {
    expect(resolveSlashAction({ name: "prompt", args: "what changed?" })).toEqual({
      kind: "prompt",
      text: "what changed?",
    });
  });

  test("/studio switches shells", () => {
    const action = resolveSlashAction({ name: "studio", args: "" });
    expect(action.kind).toBe("shell-mode");
    if (action.kind !== "shell-mode") throw new Error("expected shell-mode");
    expect(action.mode).toBe("studio");
  });

  test("/chat switches back to the chat shell", () => {
    const action = resolveSlashAction({ name: "chat", args: "" });
    expect(action.kind).toBe("shell-mode");
    if (action.kind !== "shell-mode") throw new Error("expected shell-mode");
    expect(action.mode).toBe("chat");
  });

  test("unknown commands fall through", () => {
    expect(resolveSlashAction({ name: "frobnicate", args: "x" })).toEqual({
      kind: "unknown",
      input: "/frobnicate x",
    });
  });
});

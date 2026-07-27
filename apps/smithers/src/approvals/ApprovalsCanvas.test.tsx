/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const nativeFetch = globalThis.fetch;
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
globalThis.fetch = nativeFetch;

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ApprovalsCanvas } from "./ApprovalsCanvas";
import { useApprovalsStore } from "./approvalsStore";
import type { ApprovalGate } from "./approvals";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function gate(id: string, ageMs: number, overrides: Partial<ApprovalGate> = {}): ApprovalGate {
  return {
    id,
    runId: `run-${id}`,
    nodeId: `node-${id}`,
    iteration: 2,
    workflowPath: "deploy-workflow",
    gate: `Approve ${id}`,
    status: "pending",
    source: "http",
    payload: JSON.stringify({ summary: `Context for ${id}` }),
    requestedAtMs: NOW - ageMs,
    ...overrides,
  };
}

async function renderCanvas() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(<ApprovalsCanvas />);
  });
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  useApprovalsStore.setState({
    tab: "pending",
    gates: [],
    decisions: [],
    selectedId: null,
    loading: true,
    error: null,
    nowMs: Date.now(),
  });
});

describe("ApprovalsCanvas", () => {
  test("renders actionable context and fresh, warning, and stale wait states", async () => {
    const gates = [gate("fresh", 60_000), gate("warning", 10 * 60_000), gate("stale", 31 * 60_000)];
    useApprovalsStore.setState({
      gates,
      selectedId: gates[0]!.id,
      loading: false,
      error: null,
      nowMs: NOW,
    });

    await renderCanvas();

    expect(container?.textContent).toContain("Approve fresh");
    expect(container?.textContent).toContain("deploy-workflow");
    expect(container?.textContent).toContain("run-fresh");
    expect(container?.textContent).toContain("node-fresh");
    expect(container?.textContent).toContain("Context for fresh");
    expect(container?.querySelector("[data-testid='approvals-requested-at']")?.textContent).toBe("2026-07-27 11:59:00");
    expect(
      [...container!.querySelectorAll("[data-testid='approvals-wait-time']")].map((row) =>
        row.getAttribute("data-wait-state"),
      ),
    ).toEqual(["stale", "warning", "fresh"]);
  });

  test("renders loading, unavailable, empty, and missing-context states", async () => {
    useApprovalsStore.setState({ gates: [], selectedId: null, loading: true, error: null, nowMs: NOW });
    await renderCanvas();
    expect(container?.querySelector("[data-testid='approvals-loading']")?.textContent).toContain("Loading approvals");

    await act(async () => {
      useApprovalsStore.setState({ loading: false, error: "Gateway request failed." });
    });
    expect(container?.querySelector("[data-testid='approvals-unavailable']")?.textContent).toContain(
      "Gateway request failed.",
    );

    await act(async () => {
      useApprovalsStore.setState({ loading: false, error: null, gates: [], selectedId: null });
    });
    expect(container?.querySelector("[data-testid='approvals-empty']")?.textContent).toContain("No pending approvals");

    const missing = gate("missing", 0, { workflowPath: undefined, payload: undefined });
    await act(async () => {
      useApprovalsStore.setState({ gates: [missing], selectedId: missing.id });
    });
    expect(container?.querySelector("[data-testid='approvals-workflow']")?.textContent).toBe("Unavailable");
    expect(container?.querySelector("[data-testid='approvals-context-unavailable']")?.textContent).toContain(
      "No summary or payload",
    );
  });
});

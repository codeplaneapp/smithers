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
import { bindApprovalActions, useApprovalsStore } from "./approvalsStore";
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

function click(target: Element | null) {
  if (!target) throw new Error("Missing click target");
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
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
    pendingDenyId: null,
    actingId: null,
    actionFeedback: null,
    noteById: {},
    loading: true,
    error: null,
    nowMs: Date.now(),
    rpc: null,
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

  test("submits once, disables duplicate actions, and announces success", async () => {
    const pending = gate("success", 60_000);
    let release!: () => void;
    const submitted: unknown[] = [];
    bindApprovalActions({
      submit: (vars) => {
        submitted.push(vars);
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      refetch: () => undefined,
    });
    useApprovalsStore.setState({
      gates: [pending],
      selectedId: pending.id,
      loading: false,
      error: null,
      nowMs: NOW,
    });
    await renderCanvas();

    const approve = container!.querySelector<HTMLButtonElement>("[data-testid='approvals-approve']")!;
    click(approve);
    click(approve);
    expect(submitted).toHaveLength(1);
    expect(approve.disabled).toBe(true);
    expect(container!.querySelector<HTMLButtonElement>("[data-testid='approvals-deny']")!.disabled).toBe(true);

    release();
    await flush();
    expect(useApprovalsStore.getState().gates).toHaveLength(0);
    expect(useApprovalsStore.getState().decisions[0]?.action).toBe("approved");
    const status = container!.querySelector<HTMLElement>("[role='status']");
    expect(status?.textContent).toContain("Approved Approve success");
    expect(document.activeElement).toBe(status);
  });

  test("retains a failed approval, announces the error, and permits retry", async () => {
    const pending = gate("failure", 60_000);
    let attempts = 0;
    bindApprovalActions({
      submit: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("gateway unavailable");
      },
      refetch: () => undefined,
    });
    useApprovalsStore.setState({
      gates: [pending],
      selectedId: pending.id,
      loading: false,
      error: null,
      nowMs: NOW,
    });
    await renderCanvas();

    click(container!.querySelector("[data-testid='approvals-approve']"));
    await flush();
    const alert = container!.querySelector<HTMLElement>("[role='alert']");
    expect(alert?.textContent).toContain("Could not approve Approve failure: gateway unavailable. Try again.");
    expect(document.activeElement).toBe(alert);
    expect(useApprovalsStore.getState().gates).toHaveLength(1);
    expect(container!.querySelector<HTMLButtonElement>("[data-testid='approvals-approve']")!.disabled).toBe(false);

    click(container!.querySelector("[data-testid='approvals-approve']"));
    await flush();
    expect(attempts).toBe(2);
    expect(useApprovalsStore.getState().gates).toHaveLength(0);
  });

  test("does not expose a duplicate action when refresh fails after acceptance", async () => {
    const pending = gate("accepted", 60_000);
    let submissions = 0;
    bindApprovalActions({
      submit: async () => {
        submissions += 1;
      },
      refetch: async () => {
        throw new Error("refresh failed");
      },
    });
    useApprovalsStore.setState({
      gates: [pending],
      selectedId: pending.id,
      loading: false,
      error: null,
      nowMs: NOW,
    });
    await renderCanvas();

    click(container!.querySelector("[data-testid='approvals-approve']"));
    await flush();
    expect(submissions).toBe(1);
    expect(useApprovalsStore.getState().gates).toHaveLength(0);
    expect(container!.querySelector("[data-testid='approvals-approve']")).toBeNull();
    expect(container!.querySelector("[role='status']")?.textContent).toContain("Approved Approve accepted");
  });

  test("removes an approval resolved elsewhere even when refresh fails", async () => {
    const pending = gate("stale", 60_000);
    let submissions = 0;
    let refreshes = 0;
    bindApprovalActions({
      submit: async () => {
        submissions += 1;
        const error = new Error("approval was resolved") as Error & { code: string };
        error.code = "AlreadyDecided";
        throw error;
      },
      refetch: () => {
        refreshes += 1;
        throw new Error("refresh unavailable");
      },
    });
    useApprovalsStore.setState({
      gates: [pending],
      selectedId: pending.id,
      loading: false,
      error: null,
      nowMs: NOW,
    });
    await renderCanvas();

    click(container!.querySelector("[data-testid='approvals-approve']"));
    await flush();
    expect(submissions).toBe(1);
    expect(refreshes).toBe(1);
    expect(useApprovalsStore.getState().decisions).toHaveLength(0);
    const alert = container!.querySelector<HTMLElement>("[role='alert']");
    expect(alert?.textContent).toContain("was already resolved elsewhere");
    expect(container!.textContent).toContain("No pending approvals");
    expect(container!.querySelector("[data-testid='approvals-approve']")).toBeNull();
  });

  test("deny confirmation is an alertdialog and Escape restores deny focus", async () => {
    const pending = gate("deny", 60_000);
    bindApprovalActions({ submit: async () => undefined, refetch: () => undefined });
    useApprovalsStore.setState({
      gates: [pending],
      selectedId: pending.id,
      loading: false,
      error: null,
      nowMs: NOW,
    });
    await renderCanvas();

    const deny = container!.querySelector<HTMLButtonElement>("[data-testid='approvals-deny']")!;
    click(deny);
    await flush();
    const dialog = container!.querySelector<HTMLElement>("[role='alertdialog']");
    expect(dialog?.textContent).toContain("Deny approval for");
    expect(document.activeElement).toBe(
      container!.querySelector<HTMLButtonElement>("[data-testid='approvals-deny-commit']"),
    );

    await act(async () => {
      dialog?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(container!.querySelector("[role='alertdialog']")).toBeNull();
    expect(document.activeElement).toBe(container!.querySelector("[data-testid='approvals-deny']"));
  });

  test("submits a confirmed denial and announces its result", async () => {
    const pending = gate("denied", 60_000);
    const submitted: unknown[] = [];
    bindApprovalActions({
      submit: async (vars) => {
        submitted.push(vars);
      },
      refetch: () => undefined,
    });
    useApprovalsStore.setState({
      gates: [pending],
      selectedId: pending.id,
      loading: false,
      error: null,
      nowMs: NOW,
    });
    await renderCanvas();

    click(container!.querySelector("[data-testid='approvals-deny']"));
    click(container!.querySelector("[data-testid='approvals-deny-commit']"));
    await flush();
    expect(submitted).toEqual([
      {
        runId: "run-denied",
        nodeId: "node-denied",
        iteration: 2,
        decision: { approved: false, note: undefined },
      },
    ]);
    expect(useApprovalsStore.getState().decisions[0]?.action).toBe("denied");
    expect(container!.querySelector("[role='status']")?.textContent).toContain("Denied Approve denied");
  });
});

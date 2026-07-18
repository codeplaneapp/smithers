/** @jsxImportSource react */
/**
 * The approvals notification affordance: a topbar bell whose badge tone
 * escalates with the longest-waiting approval, opening a popover dialog that
 * holds the full approve/deny inbox (monitorNotifications.tsx).
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const state: { approvals: unknown[]; submitted: unknown[]; submitError: Error | null; refetches: number } = {
  approvals: [],
  submitted: [],
  submitError: null,
  refetches: 0,
};
mock.module("smithers-orchestrator/gateway-react", () => ({
  useGatewayApprovals: () => ({ data: state.approvals, refetch: async () => { state.refetches++; } }),
  useGatewayActions: () => ({
    submitApproval: async (request: unknown) => {
      if (state.submitError) throw state.submitError;
      state.submitted.push(request);
      return {};
    },
  }),
}));

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NotificationsBell, approvalsUrgency } = await import("../src/monitor-ui/monitorNotifications.tsx");

let container: HTMLElement;
let root: import("react-dom/client").Root;
let results: Array<{ kind: string; text: string }>;
let selectedRuns: string[];

beforeEach(() => {
  state.approvals = [];
  state.submitted = [];
  state.submitError = null;
  state.refetches = 0;
  results = [];
  selectedRuns = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
afterAll(async () => { await GlobalRegistrator.unregister(); });

async function render() {
  await act(async () =>
    root.render(
      <NotificationsBell
        onSelectRun={(runId) => selectedRuns.push(runId)}
        onResult={(kind, text) => results.push({ kind, text })}
      />,
    ),
  );
}
const bell = () => container.querySelector('[data-testid="monitor-notif-bell"]') as HTMLButtonElement;
const pop = () => container.querySelector('[data-testid="monitor-notif-pop"]');
const approval = (overrides: Record<string, unknown> = {}) => ({
  runId: "run-approval-1",
  nodeId: "gate",
  iteration: 2,
  workflowKey: "implement",
  requestTitle: "Ship to prod?",
  requestSummary: "Short summary.",
  requestedAtMs: Date.now() - 6 * 60_000,
  ...overrides,
});

describe("approvalsUrgency", () => {
  test("escalates none → waiting → crit on the existing wait-tone thresholds", () => {
    const now = Date.now();
    expect(approvalsUrgency([], now)).toBe("none");
    expect(approvalsUrgency([{ runId: "r", nodeId: "n" }], now)).toBe("waiting");
    expect(approvalsUrgency([{ runId: "r", nodeId: "n", requestedAtMs: now - 60_000 }], now)).toBe("waiting");
    expect(approvalsUrgency([{ runId: "r", nodeId: "n", requestedAtMs: now - 31 * 60_000 }], now)).toBe("crit");
  });
});

describe("NotificationsBell", () => {
  test("no approvals: no badge; opening shows the quiet empty state", async () => {
    await render();
    expect(container.querySelector('[data-testid="monitor-notif-count"]')).toBeNull();
    expect(bell().getAttribute("aria-label")).toBe("Approvals inbox, none waiting");
    await act(async () => bell().click());
    expect(pop()?.getAttribute("role")).toBe("dialog");
    expect(pop()?.getAttribute("aria-label")).toBe("Approvals inbox");
    expect(pop()?.textContent).toContain("No approvals waiting");
    expect(pop()?.textContent).toContain("Runs pause here when a gate needs you.");
  });

  test("badge tone escalates from waiting to crit, with the pulse only on crit", async () => {
    state.approvals = [approval()];
    await render();
    const count = container.querySelector('[data-testid="monitor-notif-count"]');
    expect(count?.textContent).toBe("1");
    expect(bell().getAttribute("aria-label")).toBe("Approvals inbox, 1 waiting");
    expect(count?.className).toContain("tone-waiting");
    expect(container.querySelector(".mon-dot-pulse")).toBeNull();

    state.approvals = [approval(), approval({ runId: "run-old", requestedAtMs: Date.now() - 45 * 60_000 })];
    await render();
    const crit = container.querySelector('[data-testid="monitor-notif-count"]');
    expect(crit?.textContent).toBe("2");
    expect(crit?.className).toContain("tone-failed");
    expect(container.querySelector(".mon-dot-pulse")).not.toBeNull();
  });

  test("open moves focus to the dialog; Escape closes and returns it to the bell", async () => {
    state.approvals = [approval()];
    await render();
    expect(bell().getAttribute("aria-haspopup")).toBe("dialog");
    expect(bell().getAttribute("aria-expanded")).toBe("false");
    await act(async () => bell().click());
    expect(bell().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(pop());
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await act(async () => {});
    expect(pop()).toBeNull();
    expect(document.activeElement).toBe(bell());
  });

  test("long summaries clamp behind a More toggle instead of a text wall", async () => {
    const prose = "This approval gates a production deploy. ".repeat(8);
    state.approvals = [approval({ requestSummary: prose })];
    await render();
    await act(async () => bell().click());
    const summary = pop()?.querySelector(".mon-approval-summary");
    expect(summary?.classList.contains("is-open")).toBe(false);
    const more = pop()?.querySelector(".mon-approval-more") as HTMLButtonElement;
    expect(more.textContent).toBe("More");
    await act(async () => more.click());
    expect(pop()?.querySelector(".mon-approval-summary")?.classList.contains("is-open")).toBe(true);
    // Short summaries never earn the toggle.
    state.approvals = [approval()];
    await render();
    expect(pop()?.querySelector(".mon-approval-more")).toBeNull();
  });

  test("Approve submits the durable decision and reports the outcome", async () => {
    state.approvals = [approval()];
    await render();
    await act(async () => bell().click());
    const buttons = [...(pop()?.querySelectorAll("button") ?? [])] as HTMLButtonElement[];
    const approve = buttons.find((button) => button.textContent === "Approve");
    await act(async () => approve?.click());
    expect(state.submitted).toEqual([
      { runId: "run-approval-1", nodeId: "gate", iteration: 2, approved: true, decision: { approved: true } },
    ]);
    expect(results).toEqual([{ kind: "ok", text: "Approved gate on run-appr." }]);
  });

  test("Deny asks for confirmation first and a failure refetches the inbox", async () => {
    state.approvals = [approval()];
    const nativeConfirm = window.confirm;
    try {
      await render();
      await act(async () => bell().click());
      const deny = ([...(pop()?.querySelectorAll("button") ?? [])] as HTMLButtonElement[]).find(
        (button) => button.textContent === "Deny",
      );
      window.confirm = () => false;
      await act(async () => deny?.click());
      expect(state.submitted).toEqual([]);
      window.confirm = () => true;
      state.submitError = new Error("gate already resolved");
      await act(async () => deny?.click());
      expect(results.at(-1)?.kind).toBe("err");
      expect(results.at(-1)?.text).toContain("gate already resolved");
      expect(state.refetches).toBe(1);
    } finally {
      window.confirm = nativeConfirm;
    }
  });

  test("clicking an approval card opens its run and closes the popover", async () => {
    state.approvals = [approval()];
    await render();
    await act(async () => bell().click());
    const card = pop()?.querySelector(".mon-approval-main") as HTMLButtonElement;
    await act(async () => card.click());
    expect(selectedRuns).toEqual(["run-approval-1"]);
    expect(pop()).toBeNull();
  });
});

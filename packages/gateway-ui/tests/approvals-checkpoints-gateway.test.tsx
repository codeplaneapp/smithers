/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Register the DOM before react-dom/client loads; keep Bun's native fetch so
// the SSE stream works (see hookComponents.test.tsx for the full rationale).
const nativeFetch = globalThis.fetch;
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
globalThis.fetch = nativeFetch;

import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SmithersCollectionsProvider } from "@smithers-orchestrator/gateway-react";
import { GatewayApprovalConfirmation, GatewayApprovalList, gatewayApprovalKey } from "../src/GatewayApprovals.tsx";
import { GatewayCheckpointControls } from "../src/GatewayCheckpointControls.tsx";
import { startInMemoryGateway, type InMemoryGateway } from "./inMemoryGateway.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Harness = {
  container: HTMLElement;
  flush: (ms?: number) => Promise<void>;
  rerender: (element: ReactElement) => Promise<void>;
  unmount: () => Promise<void>;
};

let gateway: InMemoryGateway | undefined;
const activeHarnesses: Harness[] = [];

async function mount(gw: InMemoryGateway, element: ReactElement): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
  });
  const harness: Harness = {
    container,
    flush: async (ms = 20) => {
      await act(async () => {
        await sleep(ms);
      });
    },
    rerender: async (element: ReactElement) => {
      await act(async () => {
        root.render(
          createElement(SmithersCollectionsProvider, { mode: { kind: "local" as const, apiBaseUrl: gw.baseUrl } }, element),
        );
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
  activeHarnesses.push(harness);
  await act(async () => {
    root.render(
      createElement(SmithersCollectionsProvider, { mode: { kind: "local" as const, apiBaseUrl: gw.baseUrl } }, element),
    );
  });
  await harness.flush();
  return harness;
}

async function waitFor(harness: Harness, assertion: () => boolean, label: string, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await harness.flush(25);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function click(el: Element | null) {
  if (!el) throw new Error("click: element not found");
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

afterEach(async () => {
  for (const harness of activeHarnesses.splice(0)) {
    await harness.unmount().catch(() => undefined);
  }
  if (gateway) {
    await gateway.close();
    gateway = undefined;
  }
  document.documentElement.removeAttribute("data-theme");
});

const approvalRow = {
  runId: "run-1",
  workflowKey: "deploy",
  nodeId: "gate",
  iteration: 0,
  requestTitle: "Deploy to production?",
  requestSummary: "Ships v42 to prod.",
  requestedAtMs: Date.now(),
};

describe("gatewayApprovalKey", () => {
  test("is runId:nodeId:iteration", () => {
    expect(gatewayApprovalKey(approvalRow)).toBe("run-1:gate:0");
  });
});

describe("GatewayApprovalList", () => {
  test("renders rows from the approvals collection and resolves one", async () => {
    gateway = startInMemoryGateway({ approvals: [approvalRow] });
    const resolved: Array<{ key: string; approved: boolean }> = [];
    const harness = await mount(
      gateway,
      createElement(GatewayApprovalList, {
        onResolved: (key, approved) => resolved.push({ key, approved }),
      }),
    );
    await waitFor(harness, () => harness.container.textContent!.includes("Deploy to production?"), "row renders");
    expect(harness.container.textContent).toContain("Ships v42 to prod.");
    expect(harness.container.textContent).toContain("run-1 · gate#0");

    await act(async () => click(harness.container.querySelector("[data-decision='approve']")));
    await waitFor(harness, () => resolved.length === 1, "resolution callback");
    expect(resolved[0]).toEqual({ key: "run-1:gate:0", approved: true });
    expect(gateway.approvalsSubmitted).toHaveLength(1);
    expect(gateway.approvalsSubmitted[0]).toMatchObject({
      runId: "run-1",
      nodeId: "gate",
      iteration: 0,
      approved: true,
      decision: { approved: true },
    });
    // The resolved row leaves the collection, so the list drains to empty.
    await waitFor(harness, () => harness.container.querySelector("[data-slot='confirmation']") === null, "list drains");
  });

  test("threads the reviewer note into the decision when note is enabled", async () => {
    gateway = startInMemoryGateway({ approvals: [approvalRow] });
    const harness = await mount(gateway, createElement(GatewayApprovalList, { note: true }));
    await waitFor(harness, () => harness.container.querySelector("textarea") !== null, "note editor renders");
    const textarea = harness.container.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      textarea.dispatchEvent(new Event("focusin", { bubbles: true }));
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea) as object, "value")?.set;
      setter?.call(textarea, "lgtm");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("keyup", { bubbles: true }));
    });
    await act(async () => click(harness.container.querySelector("[data-decision='deny']")));
    await waitFor(harness, () => gateway!.approvalsSubmitted.length === 1, "deny submitted");
    expect(gateway.approvalsSubmitted[0]).toMatchObject({
      approved: false,
      decision: { approved: false, note: "lgtm" },
      note: "lgtm",
    });
  });

  test("renders the empty slot when nothing is pending", async () => {
    gateway = startInMemoryGateway({ approvals: [] });
    const harness = await mount(
      gateway,
      createElement(GatewayApprovalList, { empty: createElement("div", null, "NOTHING PENDING") }),
    );
    await waitFor(harness, () => harness.container.textContent!.includes("NOTHING PENDING"), "empty slot");
  });

  test("a failed submission re-enables the actions for retry", async () => {
    gateway = startInMemoryGateway({ approvals: [approvalRow], failApprovalSubmit: true });
    const harness = await mount(gateway, createElement(GatewayApprovalList, {}));
    await waitFor(harness, () => harness.container.querySelector("[data-decision='approve']") !== null, "row renders");
    await act(async () => click(harness.container.querySelector("[data-decision='approve']")));
    await waitFor(
      harness,
      () => harness.container.querySelector("[data-slot='confirmation']")?.getAttribute("data-state") === "failed-submission",
      "failed-submission state",
    );
    const button = harness.container.querySelector<HTMLButtonElement>("[data-decision='approve']")!;
    expect(button.disabled).toBe(false);
    // Sighted users get a visible failure note, not only a color shift.
    const note = harness.container.querySelector("[data-slot='confirmation-note']");
    expect(note).not.toBeNull();
    expect(note!.textContent).toContain("Submission failed");
  });

  test("marks the confirmation expired when the row disappears unresolved", async () => {
    gateway = startInMemoryGateway({ approvals: [approvalRow] });
    // An explicit-row confirmation stays mounted when the row vanishes (unlike
    // the list, which unmounts it) — that is where the expired state matters.
    const harness = await mount(gateway, createElement(GatewayApprovalConfirmation, { approval: approvalRow }));
    await waitFor(harness, () => harness.container.textContent!.includes("Deploy to production?"), "row renders");
    // Someone else resolves the gate elsewhere: the row leaves the collection.
    gateway.state.approvals = [];
    await act(async () => {
      // Any approvals mutation broadcasts the "approvals" change over SSE,
      // which makes the live collection re-pull (now empty).
      await fetch(`${gateway!.baseUrl}/v1/api/approvals/external`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: "other", nodeId: "gate", iteration: 9 }),
      });
    });
    await waitFor(
      harness,
      () => harness.container.querySelector("[data-slot='confirmation']")?.getAttribute("data-state") === "expired",
      "expired state",
    );
  });

  test("a failed approvals read renders unavailable, never a false expired", async () => {
    gateway = startInMemoryGateway({
      approvals: [approvalRow],
      failPaths: new Set(["/v1/api/approvals"]),
    });
    const harness = await mount(gateway, createElement(GatewayApprovalConfirmation, { approval: approvalRow }));
    await waitFor(
      harness,
      () => harness.container.querySelector("[data-slot='confirmation']")?.getAttribute("data-state") === "unavailable",
      "unavailable state",
    );
    // The gate is still pending server-side; the card must not claim expiry.
    expect(harness.container.textContent).not.toContain("expired");
    // Recovering read restores the requested gate with live actions.
    gateway.state.failPaths = new Set();
    await act(async () => {
      // An approvals mutation broadcasts the "approvals" change over SSE,
      // which makes the live collection re-pull — now successfully.
      await fetch(`${gateway!.baseUrl}/v1/api/approvals/external`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: "other", nodeId: "gate", iteration: 9 }),
      });
    });
    await waitFor(
      harness,
      () => harness.container.querySelector("[data-slot='confirmation']")?.getAttribute("data-state") === "requested",
      "recovers to requested",
    );
    expect(harness.container.querySelector<HTMLButtonElement>("[data-decision='approve']")!.disabled).toBe(false);
  });
});

describe("GatewayApprovalConfirmation", () => {
  test("renders a single explicit row without the list wrapper", async () => {
    gateway = startInMemoryGateway({ approvals: [approvalRow] });
    const harness = await mount(gateway, createElement(GatewayApprovalConfirmation, { approval: approvalRow }));
    await waitFor(harness, () => harness.container.textContent!.includes("Deploy to production?"), "row renders");
    await act(async () => click(harness.container.querySelector("[data-decision='deny']")));
    await waitFor(harness, () => harness.container.textContent!.includes("Denied"), "denied state");
    expect(gateway.approvalsSubmitted[0]).toMatchObject({ approved: false, decision: { approved: false } });
  });

  test("an identity change without a remount resets the card to requested", async () => {
    const secondRow = { ...approvalRow, nodeId: "gate-2", iteration: 1, requestTitle: "Second gate?" };
    gateway = startInMemoryGateway({ approvals: [approvalRow, secondRow] });
    const harness = await mount(gateway, createElement(GatewayApprovalConfirmation, { approval: approvalRow }));
    await waitFor(harness, () => harness.container.textContent!.includes("Deploy to production?"), "row renders");
    await act(async () => click(harness.container.querySelector("[data-decision='approve']")));
    await waitFor(
      harness,
      () => harness.container.querySelector("[data-slot='confirmation']")?.getAttribute("data-state") === "approved",
      "approved state",
    );
    // Host swaps the approval prop in place (no key change, no remount).
    await harness.rerender(createElement(GatewayApprovalConfirmation, { approval: secondRow }));
    await waitFor(
      harness,
      () => harness.container.querySelector("[data-slot='confirmation']")?.getAttribute("data-state") === "requested",
      "resets to requested",
    );
    expect(harness.container.textContent).toContain("Second gate?");
    expect(harness.container.textContent).not.toContain("Deploy to production?");
    expect(harness.container.querySelector<HTMLButtonElement>("[data-decision='approve']")!.disabled).toBe(false);
  });

  test("an in-flight submission for a previous identity never settles the current gate", async () => {
    const secondRow = { ...approvalRow, nodeId: "gate-2", iteration: 1, requestTitle: "Second gate?" };
    // The server holds submitApproval until released, so the identity swap
    // lands strictly BEFORE the first submission settles.
    gateway = startInMemoryGateway({ approvals: [approvalRow, secondRow], deferApprovalSubmit: true });
    const harness = await mount(gateway, createElement(GatewayApprovalConfirmation, { approval: approvalRow }));
    await waitFor(harness, () => harness.container.textContent!.includes("Deploy to production?"), "row renders");
    await act(async () => click(harness.container.querySelector("[data-decision='approve']")));
    await waitFor(
      harness,
      () => harness.container.querySelector("[data-slot='confirmation']")?.getAttribute("data-state") === "approving",
      "approving state",
    );
    // Host swaps the approval prop mid-flight (no remount): reset to requested.
    await harness.rerender(createElement(GatewayApprovalConfirmation, { approval: secondRow }));
    await waitFor(
      harness,
      () =>
        harness.container.querySelector("[data-slot='confirmation']")?.getAttribute("data-state") === "requested" &&
        harness.container.textContent!.includes("Second gate?"),
      "resets to requested",
    );
    // Now the stale submission for gate-1 settles. It resolved gate-1
    // server-side, but it must NOT write approved/denied/failed onto gate-2.
    gateway.releaseApprovalSubmits();
    await harness.flush(150);
    expect(gateway.approvalsSubmitted).toHaveLength(1);
    expect(gateway.approvalsSubmitted[0]).toMatchObject({ nodeId: "gate", approved: true });
    expect(harness.container.querySelector("[data-slot='confirmation']")!.getAttribute("data-state")).toBe("requested");
    expect(harness.container.querySelector<HTMLButtonElement>("[data-decision='approve']")!.disabled).toBe(false);
  });

  test("a throwing onResolved observer keeps the approved state", async () => {
    gateway = startInMemoryGateway({ approvals: [approvalRow] });
    const harness = await mount(
      gateway,
      createElement(GatewayApprovalConfirmation, {
        approval: approvalRow,
        onResolved: () => {
          throw new Error("observer boom");
        },
      }),
    );
    await waitFor(harness, () => harness.container.textContent!.includes("Deploy to production?"), "row renders");
    await act(async () => click(harness.container.querySelector("[data-decision='approve']")));
    await waitFor(harness, () => gateway!.approvalsSubmitted.length === 1, "submission lands");
    await harness.flush(50);
    // The mutation succeeded; the observer's exception must not demote the
    // card to failed-submission.
    expect(harness.container.querySelector("[data-slot='confirmation']")!.getAttribute("data-state")).toBe("approved");
    expect(harness.container.querySelector("[data-slot='confirmation-accepted']")).not.toBeNull();
  });
});

describe("GatewayCheckpointControls", () => {
  const checkpoints = [
    { id: "cp-1", label: "Start", frameNo: 1 },
    { id: "cp-2", label: "Mid", frameNo: 5 },
    { id: "cp-3", label: "Unframed" },
  ];

  test("rewinds natively through rewindRun and reports the frame", async () => {
    gateway = startInMemoryGateway({ runs: [{ runId: "run-1", status: "running" }] });
    const rewound: number[] = [];
    const harness = await mount(
      gateway,
      createElement(GatewayCheckpointControls, {
        runId: "run-1",
        checkpoints,
        currentFrameNo: 5,
        onRewound: (frameNo) => rewound.push(frameNo),
      }),
    );
    // Non-rewind kinds render ONLY when onAction is provided.
    expect(harness.container.querySelector("[data-action='restore']")).toBeNull();
    expect(harness.container.querySelectorAll("[data-action='rewind']")).toHaveLength(3);
    // The frameless checkpoint cannot rewind.
    const rows = [...harness.container.querySelectorAll("[data-slot='checkpoint']")];
    expect(rows[2]!.querySelector<HTMLButtonElement>("[data-action='rewind']")!.disabled).toBe(true);
    // current marks the live frame.
    expect(rows[1]!.getAttribute("data-current")).toBe("true");

    await act(async () => click(rows[0]!.querySelector("[data-action='rewind']")));
    await waitFor(harness, () => rewound.length === 1, "onRewound fires");
    expect(rewound).toEqual([1]);
    expect(gateway.rewinds).toHaveLength(1);
    expect(gateway.rewinds[0]).toMatchObject({ runId: "run-1", frameNo: 1, confirm: true });
  });

  test("forwards non-rewind kinds to the host onAction", async () => {
    gateway = startInMemoryGateway({ runs: [{ runId: "run-1", status: "running" }] });
    const forwarded: Array<{ kind: string; id: string }> = [];
    const harness = await mount(
      gateway,
      createElement(GatewayCheckpointControls, {
        runId: "run-1",
        checkpoints,
        onAction: (kind, checkpoint) => {
          forwarded.push({ kind, id: checkpoint.id });
        },
      }),
    );
    expect(harness.container.querySelector("[data-action='return-to-live']")).not.toBeNull();
    await act(async () => click(harness.container.querySelector("[data-action='fork']")));
    await waitFor(harness, () => forwarded.length === 1, "onAction fires");
    expect(forwarded).toEqual([{ kind: "fork", id: "cp-1" }]);
    expect(gateway.rewinds).toHaveLength(0);
  });

  test("a rejected rewindRun surfaces a role=alert failure and re-enables the actions", async () => {
    gateway = startInMemoryGateway({
      runs: [{ runId: "run-1", status: "running" }],
      failPaths: new Set(["/v1/api/runs/run-1/rewind"]),
    });
    const rewound: number[] = [];
    const harness = await mount(
      gateway,
      createElement(GatewayCheckpointControls, {
        runId: "run-1",
        checkpoints,
        onRewound: (frameNo) => rewound.push(frameNo),
      }),
    );
    const rows = [...harness.container.querySelectorAll("[data-slot='checkpoint']")];
    await act(async () => click(rows[0]!.querySelector("[data-action='rewind']")));
    await waitFor(
      harness,
      () => rows[0]!.querySelector("[data-slot='checkpoint-error']") !== null,
      "failure note renders",
    );
    const alert = rows[0]!.querySelector("[data-slot='checkpoint-error']")!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("Rewind failed");
    // No fake success: nothing was rewound, nothing reported, actions recover.
    expect(rewound).toHaveLength(0);
    expect(gateway.rewinds).toHaveLength(0);
    expect(rows[0]!.querySelector<HTMLButtonElement>("[data-action='rewind']")!.disabled).toBe(false);
    expect(rows[1]!.querySelector<HTMLButtonElement>("[data-action='rewind']")!.disabled).toBe(false);
    // Only the failed row carries the note.
    expect(rows[1]!.querySelector("[data-slot='checkpoint-error']")).toBeNull();
  });

  test("a rejected host onAction surfaces a role=alert failure instead of an unhandled rejection", async () => {
    gateway = startInMemoryGateway({ runs: [{ runId: "run-1", status: "running" }] });
    const harness = await mount(
      gateway,
      createElement(GatewayCheckpointControls, {
        runId: "run-1",
        checkpoints,
        onAction: () => Promise.reject(new Error("host fork failed")),
      }),
    );
    await act(async () => click(harness.container.querySelector("[data-action='fork']")));
    await waitFor(
      harness,
      () => harness.container.querySelector("[data-slot='checkpoint-error']") !== null,
      "failure note renders",
    );
    const alert = harness.container.querySelector("[data-slot='checkpoint-error']")!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("Fork failed: host fork failed");
    expect(harness.container.querySelector<HTMLButtonElement>("[data-action='fork']")!.disabled).toBe(false);
  });

  test("a throwing onRewound observer never converts a successful rewind into a row failure", async () => {
    gateway = startInMemoryGateway({ runs: [{ runId: "run-1", status: "running" }] });
    const harness = await mount(
      gateway,
      createElement(GatewayCheckpointControls, {
        runId: "run-1",
        checkpoints,
        onRewound: () => {
          throw new Error("observer boom");
        },
      }),
    );
    await act(async () => click(harness.container.querySelector("[data-action='rewind']")));
    await waitFor(harness, () => gateway!.rewinds.length === 1, "rewind lands");
    await harness.flush(50);
    // The rewind succeeded; the observer's exception must not surface as a
    // failure note and the actions must re-enable.
    expect(harness.container.querySelector("[data-slot='checkpoint-error']")).toBeNull();
    expect(harness.container.querySelector<HTMLButtonElement>("[data-action='rewind']")!.disabled).toBe(false);
  });
});

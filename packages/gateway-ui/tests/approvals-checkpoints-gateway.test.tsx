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
import { SmithersCollectionsProvider } from "@smthrs/gateway-react";
import { ApprovalPanel } from "../src/ApprovalPanel.tsx";
import {
  GatewayApprovalConfirmation,
  GatewayApprovalList,
  gatewayApprovalKey,
  submitDecision,
} from "../src/GatewayApprovals.tsx";
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
          createElement(
            SmithersCollectionsProvider,
            { mode: { kind: "local" as const, apiBaseUrl: gw.baseUrl } },
            element,
          ),
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

  test("keeps ApprovalPanel as an alias of the single approval list surface", () => {
    expect(ApprovalPanel).toBe(GatewayApprovalList);
  });

  test("submits the canonical server payload", async () => {
    const requests: unknown[] = [];
    await submitDecision(
      async (request) => {
        requests.push(request);
      },
      approvalRow,
      false,
      "  not yet  ",
    );
    expect(requests).toEqual([
      {
        runId: "run-1",
        nodeId: "gate",
        iteration: 0,
        decision: { approved: false, note: "not yet" },
        note: "not yet",
      },
    ]);
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
    const confirmation = harness.container.querySelector("[data-slot='deny-confirmation']");
    expect(confirmation?.getAttribute("role")).toBe("alertdialog");
    expect(confirmation?.textContent).toContain("Deploy to production?");
    expect(confirmation?.textContent).toContain("run-1");
    expect(gateway.approvalsSubmitted).toHaveLength(0);
    await act(async () =>
      click(harness.container.querySelector("[data-slot='deny-confirmation'] [data-decision='deny']")),
    );
    await waitFor(harness, () => gateway!.approvalsSubmitted.length === 1, "deny submitted");
    expect(gateway.approvalsSubmitted[0]).toMatchObject({
      decision: { approved: false, note: "lgtm" },
      note: "lgtm",
    });
  });

  test("cancels denial without losing the decision note", async () => {
    gateway = startInMemoryGateway({ approvals: [approvalRow] });
    const harness = await mount(gateway, createElement(GatewayApprovalList, { note: true }));
    await waitFor(harness, () => harness.container.querySelector("textarea") !== null, "note editor renders");
    const textarea = harness.container.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      textarea.dispatchEvent(new Event("focusin", { bubbles: true }));
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea) as object, "value")?.set;
      setter?.call(textarea, "keep this note");
      textarea.dispatchEvent(new Event("keyup", { bubbles: true }));
    });
    await act(async () => click(harness.container.querySelector("[data-decision='deny']")));
    expect((document.activeElement as HTMLElement | null)?.textContent).toBe("Confirm deny");
    const confirmation = harness.container.querySelector("[data-slot='deny-confirmation']")!;
    await act(async () =>
      confirmation.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })),
    );

    expect(harness.container.querySelector("[data-slot='deny-confirmation']")).toBeNull();
    expect(gateway.approvalsSubmitted).toHaveLength(0);
    expect(harness.container.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("keep this note");
    expect(document.activeElement).toBe(harness.container.querySelector("[data-decision='deny']"));
  });

  test("ignores duplicate approval clicks while the first submission is pending", async () => {
    gateway = startInMemoryGateway({ approvals: [approvalRow], deferApprovalSubmit: true });
    const harness = await mount(gateway, createElement(GatewayApprovalList, { note: true }));
    await waitFor(harness, () => harness.container.querySelector("[data-decision='approve']") !== null, "row renders");
    const approve = harness.container.querySelector("[data-decision='approve']");
    await act(async () => {
      click(approve);
      click(approve);
    });
    expect(harness.container.querySelector<HTMLTextAreaElement>("textarea")!.readOnly).toBe(true);
    expect(harness.container.querySelector("[data-slot='confirmation']")?.getAttribute("data-state")).toBe("approving");
    expect(harness.container.querySelectorAll("[data-slot='confirmation-action']")).toHaveLength(0);
    gateway.releaseApprovalSubmits();
    await waitFor(harness, () => gateway!.approvalsSubmitted.length === 1, "single approval submitted");
    await harness.flush(50);
    expect(gateway.approvalsSubmitted).toHaveLength(1);
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
      () =>
        harness.container.querySelector("[data-slot='confirmation']")?.getAttribute("data-state") ===
        "failed-submission",
      "failed-submission state",
    );
    const button = harness.container.querySelector<HTMLButtonElement>("[data-decision='approve']")!;
    expect(button.disabled).toBe(false);
    expect(document.activeElement).toBe(button);
    // Sighted users get a visible failure note, not only a color shift.
    const note = harness.container.querySelector("[data-slot='confirmation-note']");
    expect(note).not.toBeNull();
    expect(note!.textContent).toContain("Submission failed");
  });

  test("moves focus to the next approval after a successful keyboard-ready action", async () => {
    const secondRow = {
      ...approvalRow,
      runId: "run-2",
      nodeId: "gate-2",
      iteration: 1,
      requestTitle: "Second gate?",
    };
    gateway = startInMemoryGateway({ approvals: [approvalRow, secondRow] });
    const harness = await mount(gateway, createElement(GatewayApprovalList, {}));
    await waitFor(
      harness,
      () => harness.container.querySelectorAll("[data-decision='approve']").length === 2,
      "both approvals render",
    );
    const first = harness.container.querySelector<HTMLButtonElement>("[data-decision='approve']")!;
    first.focus();
    await act(async () => first.click());
    await waitFor(
      harness,
      () => harness.container.querySelector("[data-approval-key='run-1:gate:0']") === null,
      "first approval leaves",
    );
    expect(document.activeElement).toBe(harness.container.querySelector("[data-decision='approve']"));
    expect(
      (document.activeElement as HTMLElement).closest("[data-approval-key]")?.getAttribute("data-approval-key"),
    ).toBe("run-2:gate-2:1");
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
    expect(gateway.approvalsSubmitted).toHaveLength(0);
    await act(async () =>
      click(harness.container.querySelector("[data-slot='deny-confirmation'] [data-decision='deny']")),
    );
    await waitFor(harness, () => harness.container.textContent!.includes("Denied"), "denied state");
    expect(gateway.approvalsSubmitted[0]).toMatchObject({ decision: { approved: false } });
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
    expect(gateway.approvalsSubmitted[0]).toMatchObject({ nodeId: "gate", decision: { approved: true } });
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
    const errors: Error[] = [];
    const harness = await mount(
      gateway,
      createElement(GatewayCheckpointControls, {
        runId: "run-1",
        checkpoints,
        onError: (error: Error) => errors.push(error),
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
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0]!.message).toContain("Forced failure for /v1/api/runs/run-1/rewind");
    expect(gateway.rewinds).toHaveLength(0);
    expect(rows[0]!.querySelector<HTMLButtonElement>("[data-action='rewind']")!.disabled).toBe(false);
    expect(rows[1]!.querySelector<HTMLButtonElement>("[data-action='rewind']")!.disabled).toBe(false);
    // Only the failed row carries the note.
    expect(rows[1]!.querySelector("[data-slot='checkpoint-error']")).toBeNull();
  });

  test("a rejected host onAction surfaces a role=alert failure instead of an unhandled rejection", async () => {
    gateway = startInMemoryGateway({ runs: [{ runId: "run-1", status: "running" }] });
    const errors: Error[] = [];
    let attempts = 0;
    const harness = await mount(
      gateway,
      createElement(GatewayCheckpointControls, {
        runId: "run-1",
        checkpoints,
        onError: (error: Error) => errors.push(error),
        onAction: () => {
          attempts += 1;
          return attempts === 1 ? Promise.reject("host fork failed") : Promise.resolve();
        },
      }),
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await act(async () => click(harness.container.querySelector("[data-action='fork']")));
      await waitFor(
        harness,
        () => harness.container.querySelector("[data-slot='checkpoint-error']") !== null,
        "failure note renders",
      );
      const alert = harness.container.querySelector("[data-slot='checkpoint-error']")!;
      expect(alert.getAttribute("role")).toBe("alert");
      expect(alert.textContent).toContain("Fork failed: host fork failed");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);
      expect(errors[0]!.message).toBe("host fork failed");
      expect(harness.container.querySelector<HTMLButtonElement>("[data-action='fork']")!.disabled).toBe(false);
      await harness.flush(25);
      expect(unhandled).toHaveLength(0);
      await act(async () => click(harness.container.querySelector("[data-action='fork']")));
      await waitFor(harness, () => attempts === 2, "host action retry");
      expect(harness.container.querySelector("[data-slot='checkpoint-error']")).toBeNull();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("shows the latest failure when different actions fail on the same checkpoint", async () => {
    gateway = startInMemoryGateway({ runs: [{ runId: "run-1", status: "running" }] });
    let attempts = 0;
    const harness = await mount(
      gateway,
      createElement(GatewayCheckpointControls, {
        runId: "run-1",
        checkpoints,
        onAction: (kind) => {
          attempts += 1;
          return kind === "restore" ? Promise.resolve() : Promise.reject(new Error(`${kind} failed`));
        },
      }),
    );
    const row = harness.container.querySelector("[data-checkpoint-id='cp-1']")!;

    await act(async () => click(row.querySelector("[data-action='fork']")));
    await waitFor(harness, () => row.querySelector("[data-slot='checkpoint-error']") !== null, "fork failure renders");
    expect(row.querySelector("[data-slot='checkpoint-error']")!.textContent).toContain("Fork failed: fork failed");

    await act(async () => click(row.querySelector("[data-action='restore']")));
    await waitFor(harness, () => attempts === 2, "restore success settles");
    expect(row.querySelector("[data-slot='checkpoint-error']")).toBeNull();

    await act(async () => click(row.querySelector("[data-action='replay']")));
    await waitFor(harness, () => attempts === 3, "replay failure settles");
    expect(row.querySelector("[data-slot='checkpoint-error']")!.textContent).toContain("Replay failed: replay failed");
    expect(row.querySelector("[data-slot='checkpoint-error']")!.textContent).not.toContain("Fork failed");
  });

  test("renders prototype-named checkpoint IDs without treating inherited members as failures", async () => {
    gateway = startInMemoryGateway({ runs: [{ runId: "run-1", status: "running" }] });
    const checkpoint = { id: "toString", label: "Prototype-named checkpoint", frameNo: 1 };
    const harness = await mount(
      gateway,
      createElement(GatewayCheckpointControls, {
        runId: "run-1",
        checkpoints: [checkpoint],
        onAction: () => Promise.reject(new Error("prototype action failed")),
      }),
    );
    const row = harness.container.querySelector("[data-checkpoint-id='toString']")!;
    expect(row.querySelector("[data-slot='checkpoint-error']")).toBeNull();

    await act(async () => click(row.querySelector("[data-action='fork']")));
    await waitFor(harness, () => row.querySelector("[data-slot='checkpoint-error']") !== null, "failure note renders");
    expect(row.querySelector("[data-slot='checkpoint-error']")!.textContent).toContain(
      "Fork failed: prototype action failed",
    );
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

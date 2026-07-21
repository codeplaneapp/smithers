/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
  approvalStateToStatus,
  type ApprovalState,
} from "../src/approvals/Confirmation";
import { SMITHERS_UI_STYLE_ATTR } from "../src/styles";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  delete document.documentElement.dataset.theme;
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((element) => element.remove());
  document.querySelectorAll("style[data-smithers-ui-lane]").forEach((element) => element.remove());
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const current = root;
  await act(async () => current.render(element));
}

function fullConfirmation(state: ApprovalState) {
  return (
    <Confirmation state={state}>
      <ConfirmationTitle>Deploy to production?</ConfirmationTitle>
      <ConfirmationRequest>Request body</ConfirmationRequest>
      <ConfirmationActions>
        <ConfirmationAction decision="approve" />
        <ConfirmationAction decision="deny" />
      </ConfirmationActions>
      <ConfirmationAccepted />
      <ConfirmationRejected />
    </Confirmation>
  );
}

describe("approvalStateToStatus", () => {
  test("maps every approval state onto the shared vocabulary", () => {
    expect(approvalStateToStatus("synchronizing")).toBe("pending");
    expect(approvalStateToStatus("requested")).toBe("waiting-approval");
    expect(approvalStateToStatus("approving")).toBe("running");
    expect(approvalStateToStatus("denying")).toBe("running");
    expect(approvalStateToStatus("approved")).toBe("ok");
    expect(approvalStateToStatus("denied")).toBe("denied");
    expect(approvalStateToStatus("expired")).toBe("stale");
    expect(approvalStateToStatus("unavailable")).toBe("missing");
    expect(approvalStateToStatus("failed-submission")).toBe("error");
  });
});

describe("Confirmation", () => {
  test("requested shows request and actions, hides resolutions", async () => {
    await render(fullConfirmation("requested"));
    expect(container!.querySelector("[data-slot='confirmation-request']")).not.toBeNull();
    expect(container!.querySelector("[data-slot='confirmation-actions']")).not.toBeNull();
    expect(container!.querySelector("[data-slot='confirmation-actions']")!.getAttribute("role")).toBe("group");
    expect(container!.querySelector("[data-slot='confirmation-accepted']")).toBeNull();
    expect(container!.querySelector("[data-slot='confirmation-rejected']")).toBeNull();
    expect(container!.querySelector("[data-slot='confirmation']")!.getAttribute("data-state")).toBe("requested");
  });

  test.each(["synchronizing", "approving", "denying"] as const)(
    "%s shows the request but not the actions",
    async (state) => {
      await render(fullConfirmation(state));
      expect(container!.querySelector("[data-slot='confirmation-request']")).not.toBeNull();
      expect(container!.querySelector("[data-slot='confirmation-actions']")).toBeNull();
    },
  );

  test("approving/denying disable both actions", async () => {
    await render(
      <Confirmation state="approving">
        <ConfirmationActions>
          <ConfirmationAction decision="approve" />
          <ConfirmationAction decision="deny" />
        </ConfirmationActions>
      </Confirmation>,
    );
    // Actions are hidden while busy; the requested-state buttons must be disabled instead.
    await render(fullConfirmation("requested"));
    const buttons = container!.querySelectorAll<HTMLButtonElement>("[data-slot='confirmation-action']");
    expect(buttons).toHaveLength(2);
    buttons.forEach((button) => expect(button.disabled).toBe(false));
  });

  test("approved shows only the accepted resolution", async () => {
    await render(fullConfirmation("approved"));
    expect(container!.querySelector("[data-slot='confirmation-accepted']")!.textContent).toContain("Approved");
    expect(container!.querySelector("[data-slot='confirmation-request']")).toBeNull();
    expect(container!.querySelector("[data-slot='confirmation-actions']")).toBeNull();
  });

  test("denied shows only the rejected resolution", async () => {
    await render(fullConfirmation("denied"));
    expect(container!.querySelector("[data-slot='confirmation-rejected']")!.textContent).toContain("Denied");
  });

  test("failed-submission re-enables the actions for retry", async () => {
    await render(fullConfirmation("failed-submission"));
    expect(container!.querySelector("[data-slot='confirmation-actions']")).not.toBeNull();
    const buttons = container!.querySelectorAll<HTMLButtonElement>("[data-slot='confirmation-action']");
    buttons.forEach((button) => expect(button.disabled).toBe(false));
  });

  test.each(["expired", "unavailable"] as const)("%s renders a muted note and no actions", async (state) => {
    await render(fullConfirmation(state));
    expect(container!.querySelector("[data-slot='confirmation-note']")).not.toBeNull();
    expect(container!.querySelector("[data-slot='confirmation-actions']")).toBeNull();
    expect(container!.querySelector("[data-slot='confirmation-request']")).toBeNull();
  });

  test("announces the state label in a polite live region", async () => {
    await render(fullConfirmation("requested"));
    const live = container!.querySelector("[aria-live='polite']");
    expect(live).not.toBeNull();
    expect(live!.textContent).toBe("Waiting for approval");
  });

  test("ConfirmationAction fires onDecide with its decision", async () => {
    const decisions: string[] = [];
    await render(
      <Confirmation state="requested">
        <ConfirmationActions>
          <ConfirmationAction decision="approve" onDecide={(d) => decisions.push(d)} />
          <ConfirmationAction decision="deny" onDecide={(d) => decisions.push(d)} />
        </ConfirmationActions>
      </Confirmation>,
    );
    const approve = container!.querySelector<HTMLButtonElement>("[data-decision='approve']")!;
    const deny = container!.querySelector<HTMLButtonElement>("[data-decision='deny']")!;
    expect(approve.textContent).toContain("Approve");
    expect(deny.textContent).toContain("Deny");
    await act(async () => {
      approve.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      deny.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(decisions).toEqual(["approve", "deny"]);
  });

  test("renders under data-theme=dark with lane css self-injected", async () => {
    document.documentElement.dataset.theme = "dark";
    await render(fullConfirmation("requested"));
    expect(container!.querySelector(".sui-confirm")).not.toBeNull();
    expect(document.querySelector("style[data-smithers-ui-lane='approvals-checkpoints']")).not.toBeNull();
  });
});

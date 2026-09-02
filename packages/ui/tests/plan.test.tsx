/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Plan, type PlanStepModel, planStepStatus, SMITHERS_UI_STYLE_ATTR } from "../src/index";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

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
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const current = root;
  await act(async () => current.render(element));
}

async function nativeKeyboardActivate(button: HTMLButtonElement, key: "Enter" | " "): Promise<void> {
  await act(async () => {
    button.focus();
    button.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    button.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
    button.click();
  });
}

const STEPS: readonly PlanStepModel[] = [
  { id: "one", label: "Inspect", status: "done", detail: <span>Inspected files</span> },
  { id: "two", label: "Implement", status: "active", detail: <span>Editing now</span> },
  { id: "three", label: "Test", status: "done" },
  { id: "four", label: "Document", status: "pending" },
  { id: "five", label: "Ship", status: "skipped" },
];

describe("Plan", () => {
  test("renders a compact summary and mapped accessible step statuses", async () => {
    await render(<Plan steps={STEPS} />);

    expect(container!.querySelector('[data-slot="plan"]')?.getAttribute("data-state")).toBe("open");
    expect(container!.querySelector('[data-slot="plan-summary"]')?.textContent).toBe("2/5 done");
    expect(container!.querySelectorAll('[data-slot="plan-step"]').length).toBe(5);
    expect(container!.querySelector('[data-status="running"] .sui-sr-only')?.textContent).toBe("Running: ");
    expect(container!.querySelector('[data-status="running"]')?.getAttribute("data-status-class")).toBe("run");
    expect(container!.querySelectorAll(".sui-plan-step-dot[aria-hidden='true']").length).toBe(5);
  });

  test("uses native detail buttons with visible names and unmounted bodies", async () => {
    await render(<Plan steps={STEPS} />);
    const details = container!.querySelector('[data-slot="plan-step-toggle"]') as HTMLButtonElement;

    expect(details.tagName).toBe("BUTTON");
    expect(details.type).toBe("button");
    expect(details.textContent).toBe("Details");
    expect(details.getAttribute("aria-label")).toBe("Details: Inspect");
    expect(details.getAttribute("aria-expanded")).toBe("false");
    expect(container!.querySelector('[data-slot="plan-step-detail"]')).toBeNull();

    await nativeKeyboardActivate(details, "Enter");
    expect(details.getAttribute("aria-expanded")).toBe("true");
    expect(container!.querySelector('[data-slot="plan-step-detail"]')?.textContent).toBe("Inspected files");

    await nativeKeyboardActivate(details, " ");
    expect(details.getAttribute("aria-expanded")).toBe("false");
    expect(container!.querySelector('[data-slot="plan-step-detail"]')).toBeNull();
  });

  test("round-trips controlled per-step disclosure without self-managing", async () => {
    const changes: string[][] = [];
    function Harness() {
      const [ids, setIds] = useState<readonly string[]>([]);
      return (
        <Plan
          steps={STEPS}
          openStepIds={ids}
          onOpenStepIdsChange={(next) => {
            changes.push(next);
            setIds(next);
          }}
        />
      );
    }

    await render(<Harness />);
    const toggles = container!.querySelectorAll<HTMLButtonElement>('[data-slot="plan-step-toggle"]');
    await act(async () => toggles[1]!.click());

    expect(changes).toEqual([["two"]]);
    expect(toggles[1]!.getAttribute("aria-expanded")).toBe("true");
    expect(container!.querySelector('[data-slot="plan-step-detail"]')?.textContent).toBe("Editing now");
  });

  test("whole-plan disclosure unmounts its body and reports requested state", async () => {
    const changes: boolean[] = [];
    await render(<Plan steps={STEPS} onOpenChange={(open) => changes.push(open)} />);
    const trigger = container!.querySelector('[data-slot="plan-trigger"]') as HTMLButtonElement;

    await nativeKeyboardActivate(trigger, "Enter");
    expect(changes).toEqual([false]);
    expect(container!.querySelector('[data-slot="plan-steps"]')).toBeNull();
  });

  test("shimmers the header while streaming and renders under the dark theme", async () => {
    document.documentElement.dataset.theme = "dark";
    await render(<Plan steps={STEPS} streaming title="Release plan" />);

    expect(container!.querySelector('[data-slot="plan"]')?.getAttribute("data-streaming")).toBe("true");
    expect(container!.querySelector(".sui-plan-title")?.getAttribute("data-shimmer")).toBe("true");
    expect(container!.textContent).toContain("Release plan");
  });

  test("maps every plan status to the shared vocabulary", () => {
    expect(
      ["pending", "active", "done", "failed", "skipped"].map((status) =>
        planStepStatus(status as PlanStepModel["status"])
      ),
    ).toEqual(["pending", "running", "complete", "failed", "skipped"]);
  });
});

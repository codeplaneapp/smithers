/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  formatJsonSafe,
  SMITHERS_UI_STYLE_ATTR,
  TOOL_CALL_STATE_LABELS,
  ToolCall,
  type ToolCallState,
  toolCallStatus,
} from "../src/index";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

const states: readonly ToolCallState[] = [
  "input-streaming",
  "input-available",
  "approval-requested",
  "approval-responded",
  "running",
  "output-available",
  "output-error",
  "output-denied",
];

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  delete document.documentElement.dataset.theme;
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((el) => el.remove());
});

async function render(element: ReactElement) {
  container ??= document.body.appendChild(document.createElement("div"));
  root ??= createRoot(container);
  await act(async () => root!.render(element));
}

describe("ToolCall", () => {
  test("pins all lifecycle labels and shared status mappings", () => {
    const expected = {
      "input-streaming": "running",
      "input-available": "pending",
      "approval-requested": "waiting-approval",
      "approval-responded": "pending",
      running: "running",
      "output-available": "complete",
      "output-error": "error",
      "output-denied": "denied",
    } as const;

    for (const state of states) {
      expect(toolCallStatus(state)).toBe(expected[state]);
      const html = renderToStaticMarkup(<ToolCall name="search" state={state} />);
      expect(html).toContain(TOOL_CALL_STATE_LABELS[state]);
    }
  });

  test("renders compact and expanded anatomy", () => {
    const compact = renderToStaticMarkup(
      <ToolCall name="search" state="running" args={{ query: "status" }} defaultOpen />,
    );
    expect(compact).toContain('data-layout="compact"');
    expect(compact).toContain('data-slot="tool-call-trigger"');
    expect(compact).toContain('data-slot="tool-call-body"');
    expect(compact).toContain("&quot;query&quot;");

    const expanded = renderToStaticMarkup(
      <ToolCall name="search" state="output-available" result={{ hits: 2 }} layout="expanded" />,
    );
    expect(expanded).toContain('data-layout="expanded"');
    expect(expanded).toContain('data-state="open"');
    expect(expanded).toContain('data-slot="tool-call-header"');
    expect(expanded).not.toContain('data-slot="tool-call-trigger"');
    expect(expanded).toContain("&quot;hits&quot;");
    expect(expanded).toContain('tabindex="0"');
    expect(expanded).toContain('role="region"');
    expect(expanded).toContain('aria-label="Tool output: search"');
  });

  test("labels each focusable input and output scroll region", () => {
    const html = renderToStaticMarkup(
      <ToolCall
        name="inspect"
        state="output-available"
        layout="expanded"
        args={{ path: "src" }}
        result={{ files: 2 }}
      />,
    );
    expect(html).toContain('aria-label="Tool input: inspect"');
    expect(html).toContain('aria-label="Tool output: inspect"');
    expect(html.match(/tabindex="0"/g)?.length).toBe(2);
  });

  test("renders under the dark theme", () => {
    document.documentElement.dataset.theme = "dark";
    const html = renderToStaticMarkup(
      <ToolCall name="search" state="output-available" layout="expanded" result="ok" />,
    );
    expect(html).toContain("sui-toolcall");
  });

  test("formats BigInt and cyclic input without throwing", () => {
    expect(formatJsonSafe({ count: 4n })).toContain('"4n"');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(formatJsonSafe(cyclic)).toBe("[unserializable]");

    const html = renderToStaticMarkup(
      <ToolCall name="inspect" state="running" layout="expanded" args={{ count: 4n }} result={cyclic} />,
    );
    expect(html).toContain("4n");
    expect(html).toContain("unserializable");
  });

  test("uses text overrides for partial JSON", () => {
    const html = renderToStaticMarkup(
      <ToolCall
        name="write"
        state="input-streaming"
        layout="expanded"
        args={{ ignored: true }}
        argsText={'{"partial":'}
      />,
    );
    expect(html).toContain("partial");
    expect(html).not.toContain("ignored");
  });

  test("renders the approval seam only while approval is requested", () => {
    const requested = renderToStaticMarkup(
      <ToolCall name="deploy" state="approval-requested" approvalSlot={<button>Approve</button>} />,
    );
    expect(requested).toContain('data-slot="tool-call-approval"');
    expect(requested).toContain("Approve");

    const running = renderToStaticMarkup(
      <ToolCall name="deploy" state="running" approvalSlot={<button>Approve</button>} />,
    );
    expect(running).not.toContain('data-slot="tool-call-approval"');
    expect(running).not.toContain("Approve");
  });

  test("compact disclosure toggles and controlled state round-trips", async () => {
    const changes: boolean[] = [];
    await render(
      <ToolCall name="search" state="running" args={{ query: "status" }} onOpenChange={(open) => changes.push(open)} />,
    );
    const trigger = container!.querySelector<HTMLButtonElement>('[data-slot="tool-call-trigger"]')!;
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.type).toBe("button");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container!.querySelector('[data-slot="tool-call-body"]')).toBeNull();

    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(container!.querySelector('[data-slot="tool-call-body"]')).not.toBeNull();
    expect(changes).toEqual([true]);
  });
});

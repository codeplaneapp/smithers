/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CodeBlockFilename,
  CodeBlockGroup,
  CodeBlockHeader,
  CodeBlockTabs,
} from "../src/primitives/CodeBlock";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  delete document.documentElement.dataset.theme;
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((el) => el.remove());
  document.querySelectorAll("style[data-smithers-ui-lane]").forEach((el) => el.remove());
});

async function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
}

const items = [
  { id: "a", label: "a.ts", code: "const a = 1;", language: "ts", filename: "a.ts" },
  { id: "b", label: "b.ts", code: "const b = 2;", language: "ts" },
] as const;

describe("CodeBlockHeader and CodeBlockFilename", () => {
  test("renders a custom header row and a filename with icon slot", () => {
    const html = renderToStaticMarkup(
      <CodeBlockHeader>
        <CodeBlockFilename name="src/index.ts" icon={<span data-icon="file" />} />
      </CodeBlockHeader>,
    );
    expect(html).toContain('data-slot="code-block-header"');
    expect(html).toContain("sui-codeblock-header");
    expect(html).toContain('data-slot="code-block-filename"');
    expect(html).toContain("sui-codeblock-filename");
    expect(html).toContain("src/index.ts");
    expect(html).toContain('data-icon="file"');
  });
});

describe("CodeBlockTabs", () => {
  test("renders a tablist with aria-selected and click activation", async () => {
    const changes: string[] = [];
    await render(
      <CodeBlockTabs
        items={items.map(({ id, label }) => ({ id, label }))}
        activeId="a"
        onActiveIdChange={(id) => changes.push(id)}
      />,
    );
    const list = container!.querySelector('[role="tablist"]')!;
    const tabs = list.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs.length).toBe(2);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("false");

    await act(async () => tabs[1]!.click());
    expect(changes).toEqual(["b"]);
  });

  test("arrow keys move selection and focus", async () => {
    const changes: string[] = [];
    await render(
      <CodeBlockTabs
        items={items.map(({ id, label }) => ({ id, label }))}
        activeId="a"
        onActiveIdChange={(id) => changes.push(id)}
      />,
    );
    const tabs = container!.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs[0]!.focus();
    await act(async () => {
      tabs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    expect(changes).toEqual(["b"]);
  });

  test("roving tabindex keeps only the active tab in the tab order", async () => {
    await render(
      <CodeBlockTabs
        items={items.map(({ id, label }) => ({ id, label }))}
        activeId="a"
        onActiveIdChange={() => {}}
      />,
    );
    const tabs = container!.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs[0]!.tabIndex).toBe(0);
    expect(tabs[1]!.tabIndex).toBe(-1);
    const list = container!.querySelector('[role="tablist"]')!;
    expect(list.getAttribute("aria-label")).toBe("Code blocks");
  });

  test("arrow navigation is computed from the focused tab, not activeId", async () => {
    const changes: string[] = [];
    await render(
      <CodeBlockTabs
        items={items.map(({ id, label }) => ({ id, label }))}
        activeId="a"
        onActiveIdChange={(id) => changes.push(id)}
      />,
    );
    const tabs = container!.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    // Focus the inactive tab: ArrowLeft from tab b must land on tab a, even
    // though activeId is still "a" (delayed controlled update).
    tabs[1]!.focus();
    await act(async () => {
      tabs[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    });
    expect(changes).toEqual(["a"]);
  });
});

describe("CodeBlockGroup", () => {
  test("renders the active item with tabs and filename", () => {
    const html = renderToStaticMarkup(<CodeBlockGroup items={items} />);
    expect(html).toContain('data-slot="code-block-group"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain("sui-codeblock-filename");
    expect(html).toContain("const a = 1;");
    expect(html).not.toContain("const b = 2;");
  });

  test("defaultActiveId seeds the uncontrolled selection and tab clicks swap code", async () => {
    await render(<CodeBlockGroup items={items} defaultActiveId="b" />);
    expect(container!.textContent).toContain("const b = 2;");
    const tabs = container!.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");

    await act(async () => tabs[0]!.click());
    expect(container!.textContent).toContain("const a = 1;");
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
  });

  test("controlled activeId requests changes without self-managing", async () => {
    const changes: string[] = [];
    await render(
      <CodeBlockGroup items={items} activeId="a" onActiveIdChange={(id) => changes.push(id)} />,
    );
    const tabs = container!.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    await act(async () => tabs[1]!.click());
    expect(changes).toEqual(["b"]);
    expect(container!.textContent).toContain("const a = 1;");
  });

  test("wires tab-to-panel aria-controls and tabpanel labelling", async () => {
    await render(<CodeBlockGroup items={items} />);
    const tabs = container!.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    const panel = container!.querySelector('[role="tabpanel"]')!;
    expect(panel).not.toBeNull();
    const activeTab = tabs[0]!;
    expect(activeTab.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(activeTab.id);
    expect(activeTab.id).toBeTruthy();
    // Inactive tab points at its own (currently unrendered) panel id.
    expect(tabs[1]!.getAttribute("aria-controls")).toContain("-panel-b");
  });

  test("renders under the dark theme", () => {
    document.documentElement.dataset.theme = "dark";
    const html = renderToStaticMarkup(<CodeBlockGroup items={items} />);
    expect(html).toContain("sui-codeblock-group");
  });
});

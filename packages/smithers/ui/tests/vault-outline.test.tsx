/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { OutlineView, parseOutline } from "../src/vault/OutlineView";

const MD = [
  "# Title", // line 1
  "",
  "Some body text.",
  "## First section", // line 4
  "```",
  "# not a heading",
  "```",
  "### Nested detail", // line 8
  "## Second section ##", // line 9
].join("\n");

describe("parseOutline", () => {
  test("extracts ATX headings with depth and 1-based lines", () => {
    expect(parseOutline(MD)).toEqual([
      { depth: 1, text: "Title", line: 1 },
      { depth: 2, text: "First section", line: 4 },
      { depth: 3, text: "Nested detail", line: 8 },
      { depth: 2, text: "Second section", line: 9 },
    ]);
  });

  test("ignores headings inside fenced code", () => {
    expect(parseOutline("```\n# hidden\n```").length).toBe(0);
    expect(parseOutline("~~~\n# hidden\n~~~").length).toBe(0);
  });

  test("a heading with no space after the hashes is not a heading", () => {
    expect(parseOutline("#nope")).toEqual([]);
  });
});

describe("OutlineView", () => {
  test("renders an aria tree with indented treeitems", () => {
    const html = renderToStaticMarkup(<OutlineView markdown={MD} />);
    expect(html).toContain('role="tree"');
    expect(html).toContain('aria-label="Document outline"');
    expect(html.match(/role="treeitem"/g)).toHaveLength(4);
    expect(html).toContain('aria-level="3"');
    expect(html).toContain("Nested detail");
    expect(html).not.toContain("not a heading");
  });

  test("renders the empty copy when there are no headings", () => {
    const html = renderToStaticMarkup(<OutlineView markdown={"plain text\nno headings"} />);
    expect(html).toContain("No headings");
    expect(html).not.toContain('role="treeitem"');
  });

  test("clicking a heading reports its 1-based line", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const lines: number[] = [];
    try {
      await act(async () => {
        root.render(<OutlineView markdown={MD} onHeadingClick={(line) => lines.push(line)} />);
      });
      const items = container.querySelectorAll<HTMLElement>('[role="treeitem"]');
      expect(items).toHaveLength(4);
      await act(async () => {
        items[2]!.click();
      });
      expect(lines).toEqual([8]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("arrow keys move a roving tab stop between treeitems", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<OutlineView markdown={MD} onHeadingClick={() => {}} />);
      });
      const items = () => Array.from(container.querySelectorAll<HTMLElement>('[role="treeitem"]'));
      // One tab stop into the tree: first item only.
      expect(items().map((el) => el.tabIndex)).toEqual([0, -1, -1, -1]);

      await act(async () => {
        items()[0]!.focus();
        items()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      });
      expect(document.activeElement).toBe(items()[1]);
      expect(items().map((el) => el.tabIndex)).toEqual([-1, 0, -1, -1]);

      await act(async () => {
        items()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
      });
      expect(document.activeElement).toBe(items()[0]);
      expect(items().map((el) => el.tabIndex)).toEqual([0, -1, -1, -1]);

      // Wrap-around at both ends, plus Home/End.
      await act(async () => {
        items()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
      });
      expect(document.activeElement).toBe(items()[3]);
      await act(async () => {
        items()[3]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
      });
      expect(document.activeElement).toBe(items()[0]);
      await act(async () => {
        items()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
      });
      expect(document.activeElement).toBe(items()[3]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("Enter is not hijacked, so native button activation still fires the click handler", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<OutlineView markdown={MD} onHeadingClick={() => {}} />);
      });
      const first = container.querySelector<HTMLElement>('[role="treeitem"]')!;
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      await act(async () => {
        first.focus();
        first.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

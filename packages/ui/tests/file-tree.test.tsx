/** @jsxImportSource react */
// FileTree behavior under happy-dom: real createRoot + act (the gateway-react
// convention, same as radix-interaction.test.tsx). The DOM is registered by
// tests/happy-dom-preload.ts via bunfig `[test] preload`.
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FileTree, SMITHERS_UI_STYLE_ATTR } from "../src/index";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const r = root;
    await act(async () => r.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((el) => el.remove());
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const r = root;
  await act(async () => r.render(element));
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

const PATHS = ["src/app/main.ts", "src/app/util/helpers.ts", "src/index.ts", "README.md"];

function files(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-slot="file-tree-file"]'));
}
function dirToggles(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-slot="file-tree-dir-toggle"]'));
}

describe("FileTree", () => {
  test("groups a flat path list into a nested tree and toggles collapse", async () => {
    await render(<FileTree nodes={PATHS} />);

    expect(container!.querySelector('[role="tree"]')).toBeNull();
    expect(container!.querySelector('[role="treeitem"]')).toBeNull();

    // Directories: src, src/app, src/app/util (README.md is a root leaf).
    const dirNames = dirToggles().map((toggle) => toggle.querySelector(".sui-file-tree-dir-name")?.textContent);
    expect(dirNames).toEqual(["src", "app", "util"]);

    // All four leaves render, labelled by their last path segment.
    const names = files().map((file) => file.textContent);
    expect(names).toEqual(["helpers.ts", "main.ts", "index.ts", "README.md"]);

    // Collapse `src` -> every descendant leaf/dir disappears; only README stays.
    const srcToggle = dirToggles()[0]!;
    expect(srcToggle.getAttribute("aria-expanded")).toBe("true");
    await click(srcToggle);
    expect(srcToggle.getAttribute("aria-expanded")).toBe("false");
    expect(files().map((file) => file.textContent)).toEqual(["README.md"]);
    expect(dirToggles().length).toBe(1);

    // Expand again -> the full tree comes back.
    await click(dirToggles()[0]!);
    expect(files().length).toBe(4);
    expect(dirToggles().length).toBe(3);
  });

  test("fires onSelect with the node path and applies the active highlight", async () => {
    const selected: string[] = [];
    function Harness() {
      return <FileTree nodes={PATHS} selected="src/index.ts" onSelect={(path) => selected.push(path)} />;
    }
    await render(<Harness />);

    const active = files().find((file) => file.getAttribute("data-active") === "true");
    expect(active).not.toBeUndefined();
    expect(active!.textContent).toBe("index.ts");
    // Only the selected leaf is highlighted.
    expect(files().filter((file) => file.getAttribute("data-active") === "true").length).toBe(1);

    const readme = files().find((file) => file.textContent === "README.md")!;
    await click(readme);
    expect(selected).toEqual(["README.md"]);
  });

  test("renders the trailing affordance slot per node when provided", async () => {
    await render(
      <FileTree
        nodes={PATHS}
        renderAffordance={(node) => (node.path === "README.md" ? <span data-testid="dirty" /> : null)}
      />,
    );

    // The render slot is invoked for every leaf, but only emits for README.md.
    const affordances = document.querySelectorAll('[data-slot="file-tree-affordance"]');
    expect(affordances.length).toBe(1);
    expect(affordances[0]!.querySelector('[data-testid="dirty"]')).not.toBeNull();
  });

  test("accepts full nodes with custom labels and honors defaultCollapsed", async () => {
    await render(
      <FileTree nodes={[{ path: "src/app/main.ts", label: "Entry point" }, "docs/guide.md"]} defaultCollapsed />,
    );

    // Every directory starts collapsed: only the two top-level dirs are visible,
    // and no leaf shows yet.
    expect(files().length).toBe(0);
    expect(dirToggles().map((toggle) => toggle.getAttribute("aria-expanded"))).toEqual(["false", "false"]);

    // Drill into src -> app -> the custom-labelled leaf.
    await click(dirToggles()[0]!);
    await click(dirToggles().find((t) => t.textContent?.includes("app"))!);
    const entry = files().find((file) => file.textContent === "Entry point");
    expect(entry).not.toBeUndefined();
  });

  test("composes nodeProps without surrendering selection or structural attributes", async () => {
    const events: string[] = [];
    await render(
      <FileTree
        nodes={["active.ts", "cancelled.ts"]}
        selected="active.ts"
        onSelect={(path) => events.push(`select:${path}`)}
        nodeProps={(node) => ({
          type: "submit",
          className: "host-file",
          "data-slot": "hostile-slot",
          "data-active": "false",
          onClick: (event) => {
            events.push(`host:${node.path}`);
            if (node.path === "cancelled.ts") event.preventDefault();
          },
        })}
      />,
    );

    const active = container!.querySelector<HTMLButtonElement>('[title="active.ts"]')!;
    expect(active.type).toBe("button");
    expect(active.classList).toContain("sui-file-tree-file");
    expect(active.classList).toContain("host-file");
    expect(active.dataset.slot).toBe("file-tree-file");
    expect(active.dataset.active).toBe("true");
    await click(active);
    expect(events).toEqual(["host:active.ts", "select:active.ts"]);

    const cancelled = container!.querySelector<HTMLButtonElement>('[title="cancelled.ts"]')!;
    await click(cancelled);
    expect(events).toEqual(["host:active.ts", "select:active.ts", "host:cancelled.ts"]);
  });
});

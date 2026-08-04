import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Register a real DOM before react-dom/client is imported so click handlers
// and state updates actually run (renderToStaticMarkup below can't exercise
// the click-to-expand interaction — it never mounts). Idempotent guard keeps
// this safe if another test file in the same bun process already registered.
try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NodeChatStream } from "../src/NodeChatStream";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Pure render test: stub the gateway-node-events hook (the component's test
// seam) with a fixed frame list carrying a real reconstructed unified diff,
// exactly the shape ClaudeCodeAgent.parseFileChanges attaches to
// `detail.fileChanges` (see packages/agents file-change-contract tests).
function stubUseNodeEvents() {
  return {
    events: [
      {
        seq: 1,
        event: "AgentEvent",
        payload: {
          nodeId: "implement",
          iteration: 0,
          attempt: 1,
          engine: "claude-code",
          event: {
            type: "action",
            action: {
              kind: "file_change",
              title: "Edit",
              detail: {
                fileChanges: [
                  {
                    path: "/repo/src/a.ts",
                    kind: "modified",
                    source: "reconstructed",
                    unifiedDiff: "--- a//repo/src/a.ts\n+++ b//repo/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new",
                  },
                ],
              },
            },
          },
        },
      },
    ],
    error: null,
    loading: false,
    streaming: false,
  };
}

// A paths-only file change (e.g. CodexAgent/OpenCodeAgent — no `unifiedDiff`,
// `source: "reported"`) exercises the "diff unavailable" branch instead of
// DiffHunks.
function stubUseNodeEventsPathsOnly() {
  return {
    events: [
      {
        seq: 1,
        event: "AgentEvent",
        payload: {
          nodeId: "implement",
          iteration: 0,
          attempt: 1,
          engine: "codex",
          event: {
            type: "action",
            action: {
              kind: "file_change",
              title: "file changes",
              detail: {
                fileChanges: [{ path: "/repo/src/b.ts", kind: "created", source: "reported" }],
              },
            },
          },
        },
      },
    ],
    error: null,
    loading: false,
    streaming: false,
  };
}

describe("NodeChatStream file_change rendering", () => {
  test("renders a clickable file-change row with the path and kind", () => {
    const markup = renderToStaticMarkup(
      createElement(NodeChatStream, {
        runId: "run-1",
        nodeId: "implement",
        useNodeEvents: stubUseNodeEvents as never,
      }),
    );
    expect(markup).toContain("/repo/src/a.ts");
    expect(markup).toContain("modified");
    // Collapsed by default — the diff body is not in the initial markup.
    expect(markup).not.toContain("sui-diff-hunk-header");
  });

  test("renders 'diff unavailable' for a paths-only change and does not offer a toggle", () => {
    const markup = renderToStaticMarkup(
      createElement(NodeChatStream, {
        runId: "run-1",
        nodeId: "implement",
        useNodeEvents: stubUseNodeEventsPathsOnly as never,
      }),
    );
    expect(markup).toContain("/repo/src/b.ts");
    expect(markup).toContain("diff unavailable");
    expect(markup).not.toContain("sui-diff-hunk-header");
  });
});

describe("NodeChatStream file_change click-to-expand", () => {
  let container: HTMLElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
      root = undefined;
    }
    container?.remove();
    container = undefined;
  });

  async function mount(useNodeEvents: typeof stubUseNodeEvents) {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLElement);
      root.render(
        createElement(NodeChatStream, { runId: "run-1", nodeId: "implement", useNodeEvents: useNodeEvents as never }),
      );
    });
    return container;
  }

  function click(el: Element | null) {
    if (!el) throw new Error("click: element not found");
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }

  function findToggleButton(root: HTMLElement, pathText: string): HTMLButtonElement {
    const button = Array.from(root.querySelectorAll("button")).find((btn) => btn.textContent?.includes(pathText));
    if (!button) throw new Error(`toggle button for "${pathText}" not found`);
    return button;
  }

  test("clicking a full-diff row expands DiffHunks; clicking again collapses it", async () => {
    const el = await mount(stubUseNodeEvents);
    const toggle = findToggleButton(el, "/repo/src/a.ts");
    expect(el.textContent).not.toContain("old");

    await act(async () => click(toggle));
    expect(el.querySelector(".sui-diff-hunk-header")).not.toBeNull();
    expect(el.textContent).toContain("old");
    expect(el.textContent).toContain("new");

    await act(async () => click(toggle));
    expect(el.querySelector(".sui-diff-hunk-header")).toBeNull();
  });

  test("a paths-only row renders non-interactively — no focusable inert button", async () => {
    const el = await mount(stubUseNodeEventsPathsOnly as never);
    expect(el.textContent).toContain("/repo/src/b.ts");
    expect(el.textContent).toContain("diff unavailable");
    // No button at all for the paths-only row: nothing to expand, so the row
    // must not be focusable/clickable.
    const button = Array.from(el.querySelectorAll("button")).find((btn) => btn.textContent?.includes("/repo/src/b.ts"));
    expect(button).toBeUndefined();
    expect(el.querySelector(".sui-diff-hunk-header")).toBeNull();
  });
});

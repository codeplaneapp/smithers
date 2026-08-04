import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NodeChatStream } from "../src/NodeChatStream";

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
});

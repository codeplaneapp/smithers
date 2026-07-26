import { describe, expect, test } from "bun:test";
import { buildNodeChatTranscript } from "../src/nodeChat.ts";
import { nodeStatusIndex, rollupNodeStatus } from "../src/runNodeStatus.ts";

let seqCounter = 0;
function frame(event: string, payload: Record<string, unknown>) {
  seqCounter += 1;
  return { event, payload, seq: seqCounter };
}

function output(nodeId: string, text: string, extra: Record<string, unknown> = {}) {
  return frame("NodeOutput", { nodeId, iteration: 0, attempt: 1, text, stream: "stdout", ...extra });
}

function agentAction(nodeId: string, action: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return frame("AgentEvent", {
    nodeId,
    iteration: 0,
    attempt: 1,
    engine: "opencode",
    event: { type: "action", ...extra, action },
  });
}

describe("buildNodeChatTranscript", () => {
  test("coalesces consecutive stdout chunks into one streaming message", () => {
    const transcript = buildNodeChatTranscript(
      [output("implement", "Reading the "), output("implement", "spec now."), output("other", "noise")],
      "implement",
    );
    expect(transcript.items).toHaveLength(1);
    expect(transcript.items[0]).toMatchObject({ kind: "text", text: "Reading the spec now." });
  });

  test("merges tool started/completed phases by action id", () => {
    const transcript = buildNodeChatTranscript(
      [
        agentAction(
          "implement",
          { kind: "tool", id: "t1", title: "Bash", detail: { input: { cmd: "bun test" } } },
          { phase: "started" },
        ),
        output("implement", "running tests…"),
        agentAction(
          "implement",
          { kind: "tool", id: "t1", title: "Bash", detail: { output: "0 failures" } },
          { phase: "completed" },
        ),
      ],
      "implement",
    );
    const tools = transcript.items.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      kind: "tool",
      call: { name: "Bash", state: "output-available", resultText: "0 failures" },
    });
    expect(transcript.engine).toBe("opencode");
  });

  test("separates reasoning, stderr, and file-change notes", () => {
    const transcript = buildNodeChatTranscript(
      [
        agentAction("implement", { kind: "reasoning" }, { message: "I should check the tests." }),
        output("implement", "warning: deprecated", { stream: "stderr" }),
        agentAction("implement", {
          kind: "file_change",
          detail: { changes: [{ file: "src/a.ts" }, { file: "src/b.ts" }] },
        }),
      ],
      "implement",
    );
    expect(transcript.items.map((item) => item.kind)).toEqual(["reasoning", "stderr", "note"]);
    expect(transcript.items[2]).toMatchObject({ label: "Edited src/a.ts, src/b.ts" });
  });

  test("inserts attempt markers and derives lifecycle status", () => {
    const transcript = buildNodeChatTranscript(
      [
        frame("NodeStarted", { nodeId: "implement" }),
        output("implement", "first try"),
        output("implement", "second try", { attempt: 2 }),
        frame("NodeFinished", { nodeId: "implement" }),
      ],
      "implement",
    );
    expect(transcript.items.map((item) => item.kind)).toEqual(["text", "marker", "text"]);
    expect(transcript.items[1]).toMatchObject({ label: "attempt 2" });
    expect(transcript.status).toBe("ok");
    expect(transcript.streaming).toBe(false);
  });

  test("skips the completed answer when stdout already streamed it", () => {
    const answered = buildNodeChatTranscript(
      [
        output("implement", "The fix is in.\n"),
        frame("AgentEvent", { nodeId: "implement", event: { type: "completed", answer: "The fix is in." } }),
      ],
      "implement",
    );
    expect(answered.items).toHaveLength(1);

    const silent = buildNodeChatTranscript(
      [frame("AgentEvent", { nodeId: "implement", event: { type: "completed", answer: "Done — 3 files changed." } })],
      "implement",
    );
    expect(silent.items).toMatchObject([{ kind: "text", text: "Done — 3 files changed." }]);
  });

  test("keeps the tail and flags truncation past maxItems", () => {
    const frames = Array.from({ length: 30 }, (_, index) =>
      agentAction("implement", { kind: "file_change", detail: {}, title: `change ${index}` }),
    );
    const transcript = buildNodeChatTranscript(frames, "implement", { maxItems: 10 });
    expect(transcript.items).toHaveLength(11);
    expect(transcript.items[0]).toMatchObject({ kind: "marker", label: "earlier output truncated" });
  });
});

describe("runNodeStatus helpers", () => {
  test("nodeStatusIndex rank-merges duplicate logical ids", () => {
    const index = nodeStatusIndex([
      { id: "task", status: "failed" },
      { id: "task", status: "running" },
      { id: "plan", status: "ok" },
    ]);
    expect(index.get("task")).toBe("running");
    expect(index.get("plan")).toBe("ok");
  });

  test("nodeStatusIndex lets a recovered retry override its earlier failure", () => {
    const index = nodeStatusIndex([
      { id: "task", status: "failed", iteration: 0, attempt: 1 },
      { id: "task", status: "ok", iteration: 0, attempt: 2 },
      { id: "loop", status: "failed", iteration: 1 },
      { id: "loop", status: "ok", iteration: 2 },
      // A later-iteration failure must still surface as failed.
      { id: "regressed", status: "ok", iteration: 1 },
      { id: "regressed", status: "failed", iteration: 2 },
    ]);
    expect(index.get("task")).toBe("ok");
    expect(index.get("loop")).toBe("ok");
    expect(index.get("regressed")).toBe("failed");
  });

  test("rollupNodeStatus reads a pipeline's aggregate state", () => {
    const index = nodeStatusIndex([
      { id: "a:implement", status: "ok" },
      { id: "a:review", status: "running" },
      { id: "b:implement", status: "ok" },
      { id: "b:review", status: "ok" },
      { id: "c:implement", status: "failed" },
    ]);
    expect(rollupNodeStatus(index, ["a:implement", "a:review"])).toBe("running");
    expect(rollupNodeStatus(index, ["b:implement", "b:review"])).toBe("ok");
    expect(rollupNodeStatus(index, ["c:implement", "c:review"])).toBe("failed");
    expect(rollupNodeStatus(index, ["d:implement", "d:review"])).toBe("queued");
    expect(rollupNodeStatus(index, ["b:implement", "d:review"])).toBe("running");
  });
});

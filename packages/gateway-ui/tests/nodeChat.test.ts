import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCodeAgent } from "../../agents/src/ClaudeCodeAgent.js";
import { CodexAgent } from "../../agents/src/CodexAgent.js";
import { KimiAgent } from "../../agents/src/KimiAgent.js";
import { OpenCodeAgent } from "../../agents/src/OpenCodeAgent.js";
import { buildNodeChatTranscript } from "../src/nodeChat.ts";
import { nodeStatusIndex, rollupNodeStatus } from "../src/runNodeStatus.ts";

let seqCounter = 0;
function frame(event: string, payload: Record<string, unknown>) {
  seqCounter += 1;
  return { event, payload, seq: seqCounter };
}

function agentEventFrame(nodeId: string, engine: string, event: Record<string, unknown>) {
  return frame("AgentEvent", { nodeId, iteration: 0, attempt: 1, engine, event });
}

type FixtureEntry = {
  event?: { type?: string; phase?: string; ok?: boolean; message?: string; action?: Record<string, unknown> };
};
type Interpreter = { onStdoutLine: (line: string) => Array<Record<string, unknown>> };

const FIXTURES_DIR = join(import.meta.dir, "../../agents/tests/fixtures/cli-transcripts");

// Rebuild the raw CLI stdout line an interpreter consumed at capture time
// from the recorded AgentEvent envelope (tool id, name, and raw `input` are
// retained for file-changing tools), so fixtures replay through the live
// createOutputInterpreter path instead of filtering pre-normalized actions.
function claudeRawLine(entry: FixtureEntry): string | undefined {
  const event = entry?.event;
  const action = event?.action as { id?: string; title?: string; detail?: { input?: unknown } } | undefined;
  if (event?.type !== "action" || !action) return undefined;
  if (event.phase === "started") {
    return JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: action.id, name: action.title, input: action.detail?.input ?? {} }],
      },
    });
  }
  if (event.phase === "completed") {
    return JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: action.id, content: event.message ?? "", is_error: event.ok === false },
        ],
      },
    });
  }
  return undefined;
}

function codexRawLine(entry: FixtureEntry): string | undefined {
  const event = entry?.event;
  const action = event?.action as { id?: string; kind?: string; detail?: { changes?: unknown } } | undefined;
  if (event?.type !== "action" || action?.kind !== "file_change" || !Array.isArray(action.detail?.changes))
    return undefined;
  return JSON.stringify({
    type: "item.completed",
    item: { id: action.id, type: "file_change", changes: action.detail.changes },
  });
}

function opencodeRawLine(entry: FixtureEntry): string | undefined {
  const event = entry?.event;
  const action = event?.action as { id?: string; title?: string; detail?: { input?: unknown } } | undefined;
  // opencode emits the started+completed pair from ONE tool_use line, so only
  // the recorded started envelopes rebuild a raw line.
  if (event?.type !== "action" || event.phase !== "started" || !action) return undefined;
  return JSON.stringify({
    type: "tool_use",
    part: { tool: action.title, callID: action.id, state: { status: "completed", input: action.detail?.input ?? {} } },
  });
}

function replayFixtureTranscript(
  relativePath: string,
  agent: { createOutputInterpreter: () => Interpreter },
  engine: string,
  toRawLine: (entry: FixtureEntry) => string | undefined,
  nodeId = "mission:replay",
) {
  const interpreter = agent.createOutputInterpreter();
  const frames = [];
  for (const line of readFileSync(join(FIXTURES_DIR, relativePath), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const raw = toRawLine(JSON.parse(line));
    if (!raw) continue;
    for (const event of interpreter.onStdoutLine(raw)) {
      frames.push(agentEventFrame(nodeId, engine, event as Record<string, unknown>));
    }
  }
  return buildNodeChatTranscript(frames, nodeId);
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
    expect(transcript.items.map((item) => item.kind)).toEqual(["reasoning", "stderr", "file_change"]);
    expect(transcript.items[2]).toMatchObject({
      label: "Edited src/a.ts, src/b.ts",
      files: [
        { path: "src/a.ts", kind: "modified" },
        { path: "src/b.ts", kind: "modified" },
      ],
    });
  });

  test("prefers normalized detail.fileChanges over the legacy detail.changes scan", () => {
    const transcript = buildNodeChatTranscript(
      [
        agentAction("implement", {
          kind: "file_change",
          title: "Edit",
          detail: {
            changes: [{ file: "legacy/only.ts" }],
            fileChanges: [
              {
                path: "src/a.ts",
                kind: "modified",
                unifiedDiff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-x\n+y",
                source: "reconstructed",
              },
            ],
          },
        }),
      ],
      "implement",
    );
    expect(transcript.items).toMatchObject([
      {
        kind: "file_change",
        label: "Edited src/a.ts",
        files: [{ path: "src/a.ts", kind: "modified", unifiedDiff: expect.stringContaining("@@ -1,1 +1,1 @@") }],
      },
    ]);
  });

  test("renders a file change only after its successful completion, once", () => {
    const transcript = buildNodeChatTranscript(
      [
        agentAction(
          "implement",
          {
            kind: "file_change",
            id: "edit-1",
            title: "Edit",
            detail: { fileChanges: [{ path: "src/a.ts", kind: "modified" }] },
          },
          { phase: "started" },
        ),
        agentAction(
          "implement",
          { kind: "file_change", id: "edit-1", title: "Edit", detail: {} },
          { phase: "completed", ok: true },
        ),
        agentAction(
          "implement",
          { kind: "file_change", id: "edit-1", title: "Edit", detail: {} },
          { phase: "completed", ok: true },
        ),
        agentAction(
          "implement",
          {
            kind: "file_change",
            id: "edit-2",
            title: "Edit",
            detail: { fileChanges: [{ path: "src/b.ts", kind: "modified" }] },
          },
          { phase: "started" },
        ),
        agentAction(
          "implement",
          { kind: "file_change", id: "edit-2", title: "Edit", detail: {} },
          { phase: "completed", ok: false },
        ),
      ],
      "implement",
    );
    expect(transcript.items).toMatchObject([{ kind: "file_change", files: [{ path: "src/a.ts" }] }]);
  });

  test("replays the recorded Claude edit transcript through the live interpreter into one confirmed change with its diff", () => {
    const transcript = replayFixtureTranscript(
      "claude-code/edit-basic.jsonl",
      new ClaudeCodeAgent(),
      "claude-code",
      claudeRawLine,
    );
    const files = transcript.items.filter((item) => item.kind === "file_change");
    // Every recorded Edit correlates its started/completed pair by action id:
    // one transcript item per edit, each carrying the reconstructed diff.
    expect(files.length).toBeGreaterThan(0);
    for (const item of files) {
      if (item.kind !== "file_change") continue;
      for (const file of item.files) {
        expect(file.unifiedDiff).toContain("@@");
      }
    }
    expect(
      files.some((item) => item.kind === "file_change" && item.files.some((f) => f.path === "/repo/ui/TODO.md")),
    ).toBe(true);
  });

  test("replays the recorded Claude write transcript: created files get a diff, overwritten files stay paths-only", () => {
    const transcript = replayFixtureTranscript(
      "claude-code/write-basic.jsonl",
      new ClaudeCodeAgent(),
      "claude-code",
      claudeRawLine,
    );
    const files = transcript.items.filter((item) => item.kind === "file_change");
    const byPath = new Map<string, { kind: string; unifiedDiff?: string }>();
    for (const item of files) {
      if (item.kind !== "file_change") continue;
      for (const file of item.files) byPath.set(file.path, file);
    }
    // "File created successfully at:" → old side genuinely empty → real diff.
    const created = byPath.get("/repo/ui/docs/cloud-api-inventory.md");
    expect(created?.kind).toBe("created");
    expect(created?.unifiedDiff).toContain("+++ b/repo/ui/docs/cloud-api-inventory.md");
    // "has been updated" → prior content unknown → paths-only, no fabrication.
    const updated = byPath.get("/repo/ui/e2e/cloud/README.md");
    expect(updated).toEqual({ path: "/repo/ui/e2e/cloud/README.md", kind: "modified" });
  });

  test("replays the recorded Codex transcript into paths-only confirmed changes", () => {
    const transcript = replayFixtureTranscript(
      "codex/file-changes-basic.jsonl",
      new CodexAgent(),
      "codex",
      codexRawLine,
    );
    const files = transcript.items.filter((item) => item.kind === "file_change");
    expect(files.length).toBeGreaterThan(0);
    for (const item of files) {
      if (item.kind !== "file_change") continue;
      for (const file of item.files) expect(file.unifiedDiff).toBeUndefined();
    }
    expect(files.some((item) => item.kind === "file_change" && item.files.some((f) => f.kind === "created"))).toBe(
      true,
    );
  });

  test("replays the recorded OpenCode transcript into one confirmed change per started edit", () => {
    const transcript = replayFixtureTranscript(
      "opencode/write-edit-basic.jsonl",
      new OpenCodeAgent(),
      "opencode",
      opencodeRawLine,
    );
    const files = transcript.items.filter((item) => item.kind === "file_change");
    expect(files.length).toBeGreaterThan(0);
    const paths = files.flatMap((item) => (item.kind === "file_change" ? item.files.map((f) => f.path) : []));
    expect(paths).toContain("/repo/ui/src/ui/onboarding/SurveyCard.tsx");
    for (const item of files) {
      if (item.kind !== "file_change") continue;
      for (const file of item.files) expect(file.unifiedDiff).toBeUndefined();
    }
  });

  test("Kimi WriteFile started/completed correlation finalizes the pending change (regression: completion kept kind tool)", () => {
    const agent = new KimiAgent();
    const interpreter = agent.createOutputInterpreter();
    const events = [
      ...interpreter.onStdoutLine(
        JSON.stringify({
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "WriteFile", arguments: JSON.stringify({ path: "/repo/src/a.ts", content: "hello" }) },
            },
          ],
        }),
      ),
      ...interpreter.onStdoutLine(
        JSON.stringify({ role: "tool", tool_call_id: "call_1", content: "wrote /repo/src/a.ts" }),
      ),
    ];
    const transcript = buildNodeChatTranscript(
      events.map((event) => agentEventFrame("implement", "kimi", event)),
      "implement",
    );
    const files = transcript.items.filter((item) => item.kind === "file_change");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ kind: "file_change", files: [{ path: "/repo/src/a.ts", kind: "modified" }] });
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

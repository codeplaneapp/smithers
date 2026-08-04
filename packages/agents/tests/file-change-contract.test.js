import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCodeAgent } from "../src/ClaudeCodeAgent.js";
import { CodexAgent } from "../src/CodexAgent.js";
import { OpenCodeAgent } from "../src/OpenCodeAgent.js";
import { KimiAgent } from "../src/KimiAgent.js";
import { CursorAgent } from "../src/CursorAgent.js";
import { AmpAgent } from "../src/AmpAgent.js";
import { parseAnthropicStyleFileChanges } from "../src/BaseCliAgent/parseAnthropicStyleFileChanges.js";
import { reconstructUnifiedDiff } from "../src/BaseCliAgent/reconstructUnifiedDiff.js";

const FIXTURES_DIR = join(import.meta.dir, "fixtures/cli-transcripts");

/** @param {string} relativePath */
function readFixtureEntries(relativePath) {
  const text = readFileSync(join(FIXTURES_DIR, relativePath), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/** @param {string} relativePath */
function readFileChangeActions(relativePath) {
  return readFixtureEntries(relativePath)
    .filter((entry) => entry.event?.action?.kind === "file_change")
    .map((entry) => entry.event.action);
}

describe("ClaudeCodeAgent.parseFileChanges", () => {
  const agent = new ClaudeCodeAgent();

  it("reconstructs a unified diff from a real Edit tool_use", () => {
    const actions = readFileChangeActions("claude-code/edit-basic.jsonl");
    expect(actions.length).toBeGreaterThan(0);
    const action = actions.find((a) => a.title === "Edit");
    expect(action).toBeDefined();

    const changes = agent.parseFileChanges(action);
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe("/repo/ui/TODO.md");
    expect(changes[0].kind).toBe("modified");
    expect(changes[0].source).toBe("reconstructed");
    expect(changes[0].unifiedDiff).toContain("--- a/repo/ui/TODO.md");
    expect(changes[0].unifiedDiff).toContain("-- [ ] Auth: PKCE login, session persistence, logout, refresh.");
    expect(changes[0].unifiedDiff).toContain("+- [~] Auth: PKCE login");
  });

  it("reports a real Write tool_use paths-only while prior content is unknown", () => {
    const actions = readFileChangeActions("claude-code/write-basic.jsonl");
    expect(actions.length).toBeGreaterThan(0);
    const action = actions.find((a) => a.title === "Write" && a.detail?.input);
    expect(action).toBeDefined();

    const changes = agent.parseFileChanges(action);
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe(action.detail.input.file_path);
    expect(changes[0]).toEqual({ path: action.detail.input.file_path, kind: "modified", source: "reported" });
  });

  it("returns undefined instead of throwing on malformed vendor events", () => {
    expect(
      agent.parseFileChanges({ title: 42, detail: { input: { file_path: "/a", old_string: "x", new_string: "y" } } }),
    ).toBeUndefined();
    expect(agent.parseFileChanges("Edit")).toBeUndefined();
    expect(agent.parseFileChanges(null)).toBeUndefined();
    expect(agent.parseFileChanges(undefined)).toBeUndefined();
  });
});

describe("parseAnthropicStyleFileChanges Write/NotebookEdit reconstruction", () => {
  it("reconstructs a full-creation diff for Write once prior content is known empty", () => {
    const changes = parseAnthropicStyleFileChanges(
      "Write",
      { file_path: "/repo/a.md", content: "hello\nworld" },
      { priorContent: "" },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("created");
    expect(changes[0].source).toBe("reconstructed");
    expect(changes[0].unifiedDiff).toBe("--- a/repo/a.md\n+++ b/repo/a.md\n@@ -1,0 +1,2 @@\n+hello\n+world");
  });

  it("reconstructs a modification diff for Write with known non-empty prior content", () => {
    const changes = parseAnthropicStyleFileChanges(
      "Write",
      { file_path: "/repo/a.md", content: "new" },
      { priorContent: "old" },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("modified");
    expect(changes[0].unifiedDiff).toContain("-old");
    expect(changes[0].unifiedDiff).toContain("+new");
  });

  it("never fabricates an empty-old diff for Write when prior content is unknown", () => {
    const changes = parseAnthropicStyleFileChanges("Write", { file_path: "/repo/a.md", content: "hello" });
    expect(changes).toEqual([{ path: "/repo/a.md", kind: "modified", source: "reported" }]);
  });

  it("reconstructs a diff for NotebookEdit only in insert mode (genuinely empty old cell)", () => {
    const inserted = parseAnthropicStyleFileChanges("NotebookEdit", {
      notebook_path: "/repo/nb.ipynb",
      new_source: "print(1)",
      edit_mode: "insert",
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].source).toBe("reconstructed");
    expect(inserted[0].unifiedDiff).toContain("+print(1)");

    const replaced = parseAnthropicStyleFileChanges("NotebookEdit", {
      notebook_path: "/repo/nb.ipynb",
      new_source: "print(2)",
      edit_mode: "replace",
    });
    expect(replaced).toEqual([{ path: "/repo/nb.ipynb", kind: "modified", source: "reported" }]);
  });

  it("returns undefined instead of throwing when the tool title is not a string", () => {
    expect(parseAnthropicStyleFileChanges(42, { file_path: "/a", old_string: "x", new_string: "y" })).toBeUndefined();
    expect(parseAnthropicStyleFileChanges(undefined, { file_path: "/a" })).toBeUndefined();
  });
});

describe("CodexAgent.parseFileChanges", () => {
  const agent = new CodexAgent();

  it("reports paths + kind from real codex file_change batches, no diff content", () => {
    const actions = readFileChangeActions("codex/file-changes-basic.jsonl");
    expect(actions.length).toBeGreaterThan(0);

    const allChanges = [];
    for (const action of actions) {
      const changes = agent.parseFileChanges(action);
      expect(changes).toBeDefined();
      expect(changes.length).toBe(action.detail.changes.length);
      for (const change of changes) {
        expect(change.source).toBe("reported");
        expect(change.unifiedDiff).toBeUndefined();
        expect(typeof change.path).toBe("string");
      }
      allChanges.push(...changes);
    }
    // codex's real fixture batches "add" kinds scaffolding new connector files.
    expect(allChanges.some((c) => c.kind === "created")).toBe(true);
    expect(allChanges.some((c) => c.kind === "modified")).toBe(true);
  });
});

describe("OpenCodeAgent.parseFileChanges", () => {
  const agent = new OpenCodeAgent();

  it("reports the path from a real opencode write action, no diff content", () => {
    const actions = readFileChangeActions("opencode/write-edit-basic.jsonl");
    const action = actions.find((a) => a.title === "write");
    expect(action).toBeDefined();

    const changes = agent.parseFileChanges(action);
    expect(changes).toEqual([{ path: action.detail.input.filePath, kind: "modified", source: "reported" }]);
  });

  it("reports the path from a real opencode edit action, no diff content", () => {
    const actions = readFileChangeActions("opencode/write-edit-basic.jsonl");
    const action = actions.find((a) => a.title === "edit");
    expect(action).toBeDefined();

    const changes = agent.parseFileChanges(action);
    expect(changes).toEqual([{ path: action.detail.input.filePath, kind: "modified", source: "reported" }]);
  });

  it("returns undefined instead of throwing on malformed vendor events", () => {
    expect(agent.parseFileChanges({ title: 42, detail: { input: { filePath: "/a" } } })).toBeUndefined();
    expect(agent.parseFileChanges("write")).toBeUndefined();
    expect(agent.parseFileChanges(null)).toBeUndefined();
  });
});

// No committed transcript captured a real kimi tool call (see
// fixtures/cli-transcripts/README.md — all four captured kimi runs failed at
// startup before any tool call). These payloads are not fabricated
// transcripts: they are built directly from kimi_cli 1.48.0's own tool
// parameter schemas (`kimi_cli/tools/file/write.py::Params`,
// `kimi_cli/tools/file/replace.py::Params`/`Edit`), verified by reading the
// installed vendor package source, per the "verify against the vendor
// binary/docs" rule for engines with no fixture.
describe("KimiAgent.parseFileChanges (vendor-schema-verified, no transcript fixture)", () => {
  const agent = new KimiAgent();

  it("reports a WriteFile call paths-only (overwrite has no prior content)", () => {
    const action = {
      title: "WriteFile",
      detail: { arguments: JSON.stringify({ path: "/repo/src/a.ts", content: "hello\nworld", mode: "overwrite" }) },
    };
    const changes = agent.parseFileChanges(action);
    expect(changes).toHaveLength(1);
    expect(changes).toEqual([{ path: "/repo/src/a.ts", kind: "modified", source: "reported" }]);
  });

  it("reports WriteFile with an omitted mode paths-only", () => {
    const action = {
      title: "WriteFile",
      detail: { arguments: JSON.stringify({ path: "/repo/src/a.ts", content: "hello" }) },
    };
    const changes = agent.parseFileChanges(action);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ path: "/repo/src/a.ts", kind: "modified", source: "reported" });
  });

  it("reports (no diff) a WriteFile call in append mode — prior content is unknown", () => {
    const action = {
      title: "WriteFile",
      detail: { arguments: JSON.stringify({ path: "/repo/src/a.ts", content: "more", mode: "append" }) },
    };
    const changes = agent.parseFileChanges(action);
    expect(changes).toEqual([{ path: "/repo/src/a.ts", kind: "modified", source: "reported" }]);
  });

  it("reconstructs a unified diff from a StrReplaceFile call with a single edit", () => {
    const action = {
      title: "StrReplaceFile",
      detail: {
        arguments: JSON.stringify({
          path: "/repo/src/a.ts",
          edit: { old: "foo", new: "bar", replace_all: false },
        }),
      },
    };
    const changes = agent.parseFileChanges(action);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: "/repo/src/a.ts", kind: "modified", source: "reconstructed" });
    expect(changes[0].unifiedDiff).toContain("-foo");
    expect(changes[0].unifiedDiff).toContain("+bar");
  });

  it("reconstructs one AgentFileChange per edit from a StrReplaceFile call with a list of edits", () => {
    const action = {
      title: "StrReplaceFile",
      detail: {
        arguments: JSON.stringify({
          path: "/repo/src/a.ts",
          edit: [
            { old: "foo", new: "bar" },
            { old: "baz", new: "qux" },
          ],
        }),
      },
    };
    const changes = agent.parseFileChanges(action);
    expect(changes).toHaveLength(2);
    expect(changes[0].unifiedDiff).toContain("-foo");
    expect(changes[0].unifiedDiff).toContain("+bar");
    expect(changes[1].unifiedDiff).toContain("-baz");
    expect(changes[1].unifiedDiff).toContain("+qux");
  });

  it("returns undefined for tools other than WriteFile/StrReplaceFile", () => {
    const action = { title: "Bash", detail: { arguments: JSON.stringify({ command: "ls" }) } };
    expect(agent.parseFileChanges(action)).toBeUndefined();
  });

  it("keeps kind file_change on the completion of a WriteFile call (started/completed correlation)", () => {
    const interpreter = agent.createOutputInterpreter();
    const started = interpreter.onStdoutLine(
      JSON.stringify({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "WriteFile", arguments: JSON.stringify({ path: "/repo/a.ts", content: "hi" }) },
          },
        ],
      }),
    );
    const startedAction = started.find((e) => e.action?.id === "call_1")?.action;
    expect(startedAction?.kind).toBe("file_change");

    const completed = interpreter.onStdoutLine(JSON.stringify({ role: "tool", tool_call_id: "call_1", content: "ok" }));
    const completedAction = completed.find((e) => e.action?.id === "call_1")?.action;
    expect(completedAction?.kind).toBe("file_change");
    expect(completedAction?.title).toBe("WriteFile");
  });
});

// No committed transcript captured a real cursor or amp run (see fixtures
// README — no cursor/amp engine traffic exists in this workspace's logs).
// These payloads are built from each adapter's own documented wire shape:
// cursor-agent's protobuf `agent.v1.ToolCall` oneof (as exercised in
// cursor-support.test.js) and amp's Claude-compatible stream-json with
// `create_file`/`edit_file` tool names.
describe("CursorAgent.parseFileChanges (wire-shape-verified, no transcript fixture)", () => {
  const agent = new CursorAgent();

  it("declares paths-only file-change support", () => {
    expect(agent.capabilities.fileChanges).toEqual({ supportsFileChanges: true, supportsUnifiedDiff: false });
  });

  it("reports writeToolCall/editToolCall paths as modified, deleteToolCall as deleted", () => {
    expect(agent.parseFileChanges({ title: "write", detail: { arguments: { path: "/repo/a.ts" } } })).toEqual([
      { path: "/repo/a.ts", kind: "modified", source: "reported" },
    ]);
    expect(agent.parseFileChanges({ title: "edit", detail: { arguments: { path: "/repo/a.ts" } } })).toEqual([
      { path: "/repo/a.ts", kind: "modified", source: "reported" },
    ]);
    expect(agent.parseFileChanges({ title: "delete", detail: { arguments: { path: "/repo/a.ts" } } })).toEqual([
      { path: "/repo/a.ts", kind: "deleted", source: "reported" },
    ]);
    expect(agent.parseFileChanges({ title: "shell", detail: { arguments: { command: "ls" } } })).toBeUndefined();
  });

  it("attaches paths-only fileChanges to a writeToolCall stream event", () => {
    const interpreter = agent.createOutputInterpreter();
    const events = interpreter.onStdoutLine(
      JSON.stringify({
        type: "tool_call",
        subtype: "started",
        call_id: "call-1",
        tool_call: { tool: { case: "writeToolCall", value: { args: { path: "/repo/a.ts" } } } },
      }),
    );
    const action = events.find((e) => e.action?.kind === "file_change")?.action;
    expect(action?.detail?.fileChanges).toEqual([{ path: "/repo/a.ts", kind: "modified", source: "reported" }]);
  });

  it("classifies a deleteToolCall stream event as file_change", () => {
    const interpreter = agent.createOutputInterpreter();
    const events = interpreter.onStdoutLine(
      JSON.stringify({
        type: "tool_call",
        subtype: "started",
        call_id: "call-2",
        tool_call: { tool: { case: "deleteToolCall", value: { args: { path: "/repo/gone.ts" } } } },
      }),
    );
    const action = events.find((e) => e.action?.id === "call-2")?.action;
    expect(action?.kind).toBe("file_change");
    expect(action?.detail?.fileChanges).toEqual([{ path: "/repo/gone.ts", kind: "deleted", source: "reported" }]);
  });
});

describe("AmpAgent.parseFileChanges (wire-shape-verified, no transcript fixture)", () => {
  const agent = new AmpAgent();

  it("declares paths-only file-change support", () => {
    expect(agent.capabilities.fileChanges).toEqual({ supportsFileChanges: true, supportsUnifiedDiff: false });
  });

  it("reports create_file as created and edit_file as modified, no diff content", () => {
    expect(
      agent.parseFileChanges({ title: "create_file", detail: { input: { path: "/repo/a.ts", content: "hi" } } }),
    ).toEqual([{ path: "/repo/a.ts", kind: "created", source: "reported" }]);
    expect(agent.parseFileChanges({ title: "edit_file", detail: { input: { path: "/repo/a.ts" } } })).toEqual([
      { path: "/repo/a.ts", kind: "modified", source: "reported" },
    ]);
    expect(agent.parseFileChanges({ title: "Bash", detail: { input: { command: "ls" } } })).toBeUndefined();
  });

  it("attaches paths-only fileChanges and keeps kind file_change across started/completed", () => {
    const interpreter = agent.createOutputInterpreter();
    const started = interpreter.onStdoutLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_1", name: "create_file", input: { path: "/repo/a.ts", content: "hi" } },
          ],
        },
      }),
    );
    const startedAction = started.find((e) => e.action?.id === "toolu_1")?.action;
    expect(startedAction?.kind).toBe("file_change");
    expect(startedAction?.detail?.fileChanges).toEqual([{ path: "/repo/a.ts", kind: "created", source: "reported" }]);

    const completed = interpreter.onStdoutLine(
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "done" }] },
      }),
    );
    const completedAction = completed.find((e) => e.action?.id === "toolu_1")?.action;
    expect(completedAction?.kind).toBe("file_change");
  });
});

// The fixture-driven tests above replay `event.action` envelopes as recorded
// (post-interpretation) — they exercise the shared parse functions but never
// the interpreter code path that actually attaches `detail.fileChanges`
// during live stream parsing (`createOutputInterpreter().onStdoutLine`).
// Real per-engine raw CLI payloads aren't retained in any committed log (see
// fixtures README), so these synthetic lines are built directly from each
// adapter's own parsing branches, not fabricated transcript content.
describe("createOutputInterpreter attaches detail.fileChanges (synthetic raw stream)", () => {
  it("ClaudeCodeAgent: attaches fileChanges to a tool_use action for Edit", () => {
    const agent = new ClaudeCodeAgent();
    const interpreter = agent.createOutputInterpreter();
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Edit",
            input: { file_path: "/repo/a.ts", old_string: "foo", new_string: "bar" },
          },
        ],
      },
    });
    const events = interpreter.onStdoutLine(line);
    const action = events.find((e) => e.action?.kind === "file_change")?.action;
    expect(action?.detail?.fileChanges).toEqual([
      {
        path: "/repo/a.ts",
        kind: "modified",
        unifiedDiff: expect.stringContaining("-foo"),
        source: "reconstructed",
      },
    ]);
  });

  it("CodexAgent: attaches fileChanges to an item.completed file_change action", () => {
    const agent = new CodexAgent();
    const interpreter = agent.createOutputInterpreter();
    const line = JSON.stringify({
      type: "item.completed",
      item: { id: "item-1", type: "file_change", changes: [{ path: "/repo/a.ts", kind: "update" }] },
    });
    const events = interpreter.onStdoutLine(line);
    const action = events.find((e) => e.action?.kind === "file_change")?.action;
    expect(action?.detail?.fileChanges).toEqual([{ path: "/repo/a.ts", kind: "modified", source: "reported" }]);
  });

  it("OpenCodeAgent: attaches fileChanges to a tool_use write action", () => {
    const agent = new OpenCodeAgent();
    const interpreter = agent.createOutputInterpreter();
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        tool: "write",
        callID: "call_1",
        state: { status: "completed", input: { filePath: "/repo/a.ts", content: "hello" } },
      },
    });
    const events = interpreter.onStdoutLine(line);
    const action = events.find((e) => e.action?.kind === "file_change")?.action;
    expect(action?.detail?.fileChanges).toEqual([{ path: "/repo/a.ts", kind: "modified", source: "reported" }]);
  });

  it("KimiAgent: attaches paths-only fileChanges to an assistant WriteFile action", () => {
    const agent = new KimiAgent();
    const interpreter = agent.createOutputInterpreter();
    const line = JSON.stringify({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "WriteFile",
            arguments: JSON.stringify({ path: "/repo/a.ts", content: "hello", mode: "overwrite" }),
          },
        },
      ],
    });
    const events = interpreter.onStdoutLine(line);
    const action = events.find((e) => e.action?.kind === "file_change")?.action;
    expect(action?.detail?.fileChanges).toEqual([{ path: "/repo/a.ts", kind: "modified", source: "reported" }]);
  });
});

// Replays of the recorded fixture transcripts through the live interpreter
// path: each recorded `AgentEvent` envelope carries enough of the original
// wire payload (tool id, name, and the raw `input` for file-changing tools)
// to deterministically rebuild the raw CLI stream line the interpreter
// consumed at capture time. Feeding those rebuilt lines through
// `createOutputInterpreter` exercises the real attachment and correlation
// code end-to-end, instead of filtering pre-normalized actions.
describe("recorded fixtures replay through createOutputInterpreter", () => {
  /**
   * @param {unknown} entry - one recorded stream.ndjson envelope line
   * @returns {string | undefined} rebuilt raw CLI stdout line, or undefined to skip
   */
  const claudeRawLine = (entry) => {
    const event = entry?.event;
    const action = event?.action;
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
  };
  const codexRawLine = (entry) => {
    const event = entry?.event;
    const action = event?.action;
    if (event?.type !== "action" || action?.kind !== "file_change" || !Array.isArray(action.detail?.changes))
      return undefined;
    return JSON.stringify({
      type: "item.completed",
      item: { id: action.id, type: "file_change", changes: action.detail.changes },
    });
  };
  const opencodeRawLine = (entry) => {
    const event = entry?.event;
    const action = event?.action;
    // opencode emits the started+completed pair from ONE tool_use line, so
    // only the recorded started envelopes rebuild a raw line.
    if (event?.type !== "action" || event.phase !== "started" || !action) return undefined;
    return JSON.stringify({
      type: "tool_use",
      part: {
        tool: action.title,
        callID: action.id,
        state: { status: "completed", input: action.detail?.input ?? {} },
      },
    });
  };

  /**
   * @param {string} relativePath
   * @param {{ createOutputInterpreter: () => { onStdoutLine: (line: string) => any[] } }} agent
   * @param {(entry: unknown) => string | undefined} toRawLine
   */
  function replayFixture(relativePath, agent, toRawLine) {
    const interpreter = agent.createOutputInterpreter();
    const actions = [];
    for (const entry of readFixtureEntries(relativePath)) {
      const raw = toRawLine(entry);
      if (!raw) continue;
      for (const event of interpreter.onStdoutLine(raw)) {
        if (event?.type === "action") actions.push(event);
      }
    }
    return actions;
  }

  it("claude-code edit-basic: every started edit finalizes with a reconstructed diff", () => {
    const actions = replayFixture("claude-code/edit-basic.jsonl", new ClaudeCodeAgent(), claudeRawLine);
    const started = actions.filter((e) => e.phase === "started" && e.action.kind === "file_change");
    const completed = actions.filter((e) => e.phase === "completed" && e.action.kind === "file_change");
    expect(started.length).toBeGreaterThan(0);
    // Start/completion correlation: same action ids, same kind on both phases.
    expect(new Set(completed.map((e) => e.action.id))).toEqual(new Set(started.map((e) => e.action.id)));
    for (const event of started) {
      const fileChanges = event.action.detail?.fileChanges;
      expect(Array.isArray(fileChanges)).toBe(true);
      for (const change of fileChanges) {
        expect(change.source).toBe("reconstructed");
        expect(change.unifiedDiff).toContain("@@");
      }
    }
  });

  it("claude-code write-basic: created Writes reconstruct a diff, updated Writes stay paths-only", () => {
    const actions = replayFixture("claude-code/write-basic.jsonl", new ClaudeCodeAgent(), claudeRawLine);
    const completedWrites = actions.filter((e) => e.phase === "completed" && e.action.title === "Write");
    expect(completedWrites.length).toBeGreaterThan(0);
    for (const event of completedWrites) {
      const fileChanges = event.action.detail?.fileChanges;
      expect(Array.isArray(fileChanges)).toBe(true);
      expect(fileChanges).toHaveLength(1);
      const message = event.message ?? "";
      if (message.startsWith("File created successfully at:")) {
        expect(fileChanges[0].kind).toBe("created");
        expect(fileChanges[0].source).toBe("reconstructed");
        expect(fileChanges[0].unifiedDiff).toContain(`+++ b${fileChanges[0].path}`);
      } else {
        // Existing file, prior content unknown — no fabricated empty-old diff.
        expect(fileChanges[0]).toEqual({ path: fileChanges[0].path, kind: "modified", source: "reported" });
      }
    }
    // The recorded transcript contains at least one of each Write outcome.
    expect(completedWrites.some((e) => (e.message ?? "").startsWith("File created successfully at:"))).toBe(true);
    expect(completedWrites.some((e) => !(e.message ?? "").startsWith("File created successfully at:"))).toBe(true);
    // Correlation: every Write completion shares its id with a started Write.
    const startedWriteIds = new Set(
      actions.filter((e) => e.phase === "started" && e.action.title === "Write").map((e) => e.action.id),
    );
    for (const event of completedWrites) expect(startedWriteIds.has(event.action.id)).toBe(true);
  });

  it("codex file-changes-basic: reported paths+kind, never diff content", () => {
    const actions = replayFixture("codex/file-changes-basic.jsonl", new CodexAgent(), codexRawLine);
    const fileChangeActions = actions.filter((e) => e.action.kind === "file_change");
    expect(fileChangeActions.length).toBeGreaterThan(0);
    for (const event of fileChangeActions) {
      const fileChanges = event.action.detail?.fileChanges;
      expect(Array.isArray(fileChanges)).toBe(true);
      for (const change of fileChanges) {
        expect(change.source).toBe("reported");
        expect(change.unifiedDiff).toBeUndefined();
      }
    }
  });

  it("opencode write-edit-basic: started/completed pairs share ids and paths-only fileChanges", () => {
    const actions = replayFixture("opencode/write-edit-basic.jsonl", new OpenCodeAgent(), opencodeRawLine);
    const started = actions.filter((e) => e.phase === "started" && e.action.kind === "file_change");
    const completed = actions.filter((e) => e.phase === "completed" && e.action.kind === "file_change");
    expect(started.length).toBeGreaterThan(0);
    expect(new Set(completed.map((e) => e.action.id))).toEqual(new Set(started.map((e) => e.action.id)));
    for (const event of started) {
      const fileChanges = event.action.detail?.fileChanges;
      expect(Array.isArray(fileChanges)).toBe(true);
      for (const change of fileChanges) {
        expect(change.source).toBe("reported");
        expect(change.unifiedDiff).toBeUndefined();
      }
    }
  });
});

describe("reconstructUnifiedDiff safety and patch shape", () => {
  it("emits a valid empty-to-content hunk without a phantom deleted line", () => {
    expect(reconstructUnifiedDiff("src/a.ts", "", "hello\nworld")).toBe(
      "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +1,2 @@\n+hello\n+world",
    );
  });

  it("emits a valid content-to-empty hunk without a phantom added line", () => {
    expect(reconstructUnifiedDiff("src/a.ts", "hello\nworld", "")).toBe(
      "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,0 @@\n-hello\n-world",
    );
  });

  it("bounds each dimension, not just the cell product (empty side must not bypass the guard)", () => {
    const huge = Array.from({ length: 1_000_001 }, () => "x").join("\n");
    expect(reconstructUnifiedDiff("src/a.ts", "", huge)).toBeUndefined();
    expect(reconstructUnifiedDiff("src/a.ts", huge, "")).toBeUndefined();
  });

  it("falls back to no diff before allocating an unbounded LCS matrix", () => {
    const text = Array.from({ length: 1_001 }, (_, index) => String(index)).join("\n");
    expect(reconstructUnifiedDiff("src/a.ts", text, text.replace("1000", "changed"))).toBeUndefined();
  });
});

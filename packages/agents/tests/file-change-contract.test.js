import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCodeAgent } from "../src/ClaudeCodeAgent.js";
import { CodexAgent } from "../src/CodexAgent.js";
import { OpenCodeAgent } from "../src/OpenCodeAgent.js";

const FIXTURES_DIR = join(import.meta.dir, "fixtures/cli-transcripts");

/** @param {string} relativePath */
function readFileChangeActions(relativePath) {
  const text = readFileSync(join(FIXTURES_DIR, relativePath), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
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
    expect(changes[0].path).toBe("/Users/williamcory/flows/ui/TODO.md");
    expect(changes[0].kind).toBe("modified");
    expect(changes[0].source).toBe("reconstructed");
    expect(changes[0].unifiedDiff).toContain("--- a//Users/williamcory/flows/ui/TODO.md");
    expect(changes[0].unifiedDiff).toContain("-- [ ] Auth: PKCE login, session persistence, logout, refresh.");
    expect(changes[0].unifiedDiff).toContain("+- [~] Auth: PKCE login");
  });

  it("reconstructs a unified diff from a real Write tool_use", () => {
    const actions = readFileChangeActions("claude-code/write-basic.jsonl");
    expect(actions.length).toBeGreaterThan(0);
    const action = actions.find((a) => a.title === "Write");
    expect(action).toBeDefined();

    const changes = agent.parseFileChanges(action);
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe(action.detail.input.file_path);
    expect(changes[0].source).toBe("reconstructed");
    expect(changes[0].unifiedDiff).toContain("--- a/");
    expect(changes[0].unifiedDiff).toContain("+++ b/");
    // Every content line is an addition against the empty "old" side.
    const contentFirstLine = action.detail.input.content.split("\n")[0];
    expect(changes[0].unifiedDiff).toContain(`+${contentFirstLine}`);
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
});

import { isRecord, asString } from "./parseHelpers.js";
import { reconstructUnifiedDiff } from "./reconstructUnifiedDiff.js";
/** @typedef {import("../agent-contract/AgentFileChange.ts").AgentFileChange} AgentFileChange */

/**
 * Shared `parseFileChanges` logic for harnesses that share Claude Code's
 * Anthropic-style `tool_use` shape (Claude Code, Kimi): `Edit`/`MultiEdit`
 * carry `old_string`/`new_string`/`file_path` verbatim in the tool input;
 * `Write` carries `content`+`file_path`. All content is already in-hand, so
 * diffs are reconstructed locally without touching the filesystem.
 *
 * @param {string} toolTitle - the tool_use block's `name` (e.g. "Edit")
 * @param {unknown} input - the tool_use block's `input`
 * @returns {AgentFileChange[] | undefined}
 */
export function parseAnthropicStyleFileChanges(toolTitle, input) {
  if (!isRecord(input)) return undefined;
  const name = toolTitle.toLowerCase();
  if (name === "edit") {
    const path = asString(input.file_path);
    const oldString = asString(input.old_string);
    const newString = asString(input.new_string);
    if (!path || oldString === undefined || newString === undefined) return undefined;
    return [
      {
        path,
        kind: "modified",
        unifiedDiff: reconstructUnifiedDiff(path, oldString, newString),
        source: "reconstructed",
      },
    ];
  }
  if (name === "multiedit") {
    const path = asString(input.file_path);
    const edits = Array.isArray(input.edits) ? input.edits : [];
    if (!path || edits.length === 0) return undefined;
    const changes = [];
    for (const edit of edits) {
      if (!isRecord(edit)) continue;
      const oldString = asString(edit.old_string);
      const newString = asString(edit.new_string);
      if (oldString === undefined || newString === undefined) continue;
      changes.push({
        path,
        kind: "modified",
        unifiedDiff: reconstructUnifiedDiff(path, oldString, newString),
        source: "reconstructed",
      });
    }
    return changes.length > 0 ? changes : undefined;
  }
  if (name === "write") {
    const path = asString(input.file_path);
    const content = asString(input.content);
    if (!path || content === undefined) return undefined;
    return [
      {
        path,
        kind: "modified",
        unifiedDiff: reconstructUnifiedDiff(path, "", content),
        source: "reconstructed",
      },
    ];
  }
  if (name === "notebookedit") {
    // No old-cell content in-hand (cell addressed by id, not by full
    // notebook content) — report the path without fabricating a diff.
    const path = asString(input.notebook_path);
    if (!path) return undefined;
    return [{ path, kind: "modified", source: "reconstructed" }];
  }
  return undefined;
}

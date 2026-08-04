import { isRecord, asString } from "./parseHelpers.js";
import { reconstructUnifiedDiff } from "./reconstructUnifiedDiff.js";
/** @typedef {import("../agent-contract/AgentFileChange.ts").AgentFileChange} AgentFileChange */

/**
 * Shared `parseFileChanges` logic for harnesses that share Claude Code's
 * Anthropic-style `tool_use` shape: `Edit`/`MultiEdit`
 * carry `old_string`/`new_string`/`file_path` verbatim in the tool input;
 * `Write` carries only the new full-file `content`, so a diff can only be
 * reconstructed when the caller separately knows the prior content (pass
 * `options.priorContent` — e.g. `""` once the tool result confirms the file
 * was newly created). Without that knowledge a `Write` stays paths-only: an
 * empty-old diff over an EXISTING file would be fabricated.
 * `NotebookEdit` carries `new_source`; only `edit_mode: "insert"` has a
 * genuinely empty old cell, so only inserts reconstruct a diff.
 *
 * @param {unknown} toolTitle - the tool_use block's `name` (e.g. "Edit")
 * @param {unknown} input - the tool_use block's `input`
 * @param {{ priorContent?: string }} [options] - known prior file content (Write only)
 * @returns {AgentFileChange[] | undefined}
 */
export function parseAnthropicStyleFileChanges(toolTitle, input, options) {
  if (!isRecord(input)) return undefined;
  const name = asString(toolTitle)?.toLowerCase() ?? "";
  if (name === "edit") {
    const path = asString(input.file_path);
    const oldString = asString(input.old_string);
    const newString = asString(input.new_string);
    if (!path || oldString === undefined || newString === undefined) return undefined;
    const unifiedDiff = reconstructUnifiedDiff(path, oldString, newString);
    return [
      { path, kind: "modified", ...(unifiedDiff ? { unifiedDiff, source: "reconstructed" } : { source: "reported" }) },
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
      const unifiedDiff = reconstructUnifiedDiff(path, oldString, newString);
      changes.push({
        path,
        kind: "modified",
        ...(unifiedDiff ? { unifiedDiff, source: "reconstructed" } : { source: "reported" }),
      });
    }
    return changes.length > 0 ? changes : undefined;
  }
  if (name === "write") {
    const path = asString(input.file_path);
    const content = asString(input.content);
    if (!path || content === undefined) return undefined;
    const priorContent = options?.priorContent;
    if (priorContent !== undefined) {
      const unifiedDiff = reconstructUnifiedDiff(path, priorContent, content);
      const kind = priorContent === "" ? "created" : "modified";
      return [{ path, kind, ...(unifiedDiff ? { unifiedDiff, source: "reconstructed" } : { source: "reported" }) }];
    }
    return [{ path, kind: "modified", source: "reported" }];
  }
  if (name === "notebookedit") {
    const path = asString(input.notebook_path);
    if (!path) return undefined;
    const newSource = asString(input.new_source);
    const editMode = asString(input.edit_mode);
    // Only an inserted cell has a genuinely empty old side; replace/delete
    // address an existing cell whose prior content is not in-hand — report
    // the path without fabricating a diff.
    if (editMode === "insert" && newSource !== undefined) {
      const unifiedDiff = reconstructUnifiedDiff(path, "", newSource);
      return [
        {
          path,
          kind: "modified",
          ...(unifiedDiff ? { unifiedDiff, source: "reconstructed" } : { source: "reported" }),
        },
      ];
    }
    return [{ path, kind: "modified", source: "reported" }];
  }
  return undefined;
}

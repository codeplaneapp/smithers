/**
 * Parse the `/* smithers ... *\/` frontmatter block from a workflow source file.
 *
 * This matches the format used by the Smithers CLI (apps/cli/src/workflows.js)
 * and the elizaOS Skill YAML frontmatter convention, adapted for JS/TS comment
 * syntax so the file stays valid TSX.
 *
 * Supports:
 *   - `key: scalar value` lines
 *   - `key: [a, b, c]` inline lists
 *   - Block lists:
 *       key:
 *       - item1
 *       - item2
 *   - Quoted values (single or double quotes stripped)
 *
 * @module
 */

import type { WorkflowFrontmatter } from "./types.js";

/**
 * Parse the leading `/* smithers ... *\/` frontmatter block from `source`.
 * Returns an empty object when no block is present.
 */
export function parseWorkflowFrontmatter(source: string): WorkflowFrontmatter {
  const match = source.match(/\/\*\s*smithers\b[^\n]*\n([\s\S]*?)\*\//);
  if (!match) return {};

  const out: Record<string, unknown> = {};
  const lines = match[1].split("\n");
  let listKey: string | undefined;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) continue;

    // Block list item: `- value`
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && listKey) {
      const arr = (out[listKey] ??= []) as string[];
      arr.push(unquoteYaml(listItem[1]));
      continue;
    }

    // Key-value pair
    const kv = line.match(/^\s*([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;

    const key = kv[1];
    const value = kv[2].trim();

    if (value === "") {
      // `key:` with no value begins a block list
      listKey = key;
      out[key] ??= [];
      continue;
    }

    listKey = undefined;

    const inlineList = value.match(/^\[(.*)\]$/);
    if (inlineList) {
      out[key] = inlineList[1]
        .split(",")
        .map((entry) => unquoteYaml(entry.trim()))
        .filter(Boolean);
    } else if (value.toLowerCase() === "true") {
      out[key] = true;
    } else if (value.toLowerCase() === "false") {
      out[key] = false;
    } else {
      out[key] = unquoteYaml(value);
    }
  }

  return out as WorkflowFrontmatter;
}

/** Strip surrounding single or double quotes from a YAML scalar value. */
function unquoteYaml(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Generate a `/* smithers ... *\/` frontmatter block string from a plain object.
 * Useful for scaffolding new workflow files.
 */
export function serializeWorkflowFrontmatter(
  fields: WorkflowFrontmatter
): string {
  const lines: string[] = ["/* smithers"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(", ")}]`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  lines.push("*/");
  return lines.join("\n") + "\n";
}

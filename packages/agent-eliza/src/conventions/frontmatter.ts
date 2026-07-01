/**
 * Parse and serialize `---`-fenced YAML frontmatter blocks.
 *
 * Matches the elizaOS Skill frontmatter convention:
 * a leading `---\n...\n---\n` block containing YAML key-value pairs.
 *
 * @module
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { WorkflowFrontmatter } from "./types.js";

/** Regex that matches a leading `---` YAML frontmatter block. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

/**
 * Parse the `---`-fenced YAML frontmatter block from `source`.
 *
 * Returns `{ frontmatter, body }` where `body` is the remainder of the file
 * after the closing `---`. When no frontmatter block is present, `frontmatter`
 * is an empty object and `body` equals `source`.
 */
export function parseWorkflowFrontmatter(source: string): {
  frontmatter: WorkflowFrontmatter;
  body: string;
} {
  const match = source.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, body: source };
  }

  const yamlBlock = match[1] ?? "";
  const body = match[2] ?? "";

  let frontmatter: WorkflowFrontmatter = {};
  try {
    const parsed = parseYaml(yamlBlock);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = parsed as WorkflowFrontmatter;
    }
  } catch {
    // Malformed YAML — return empty frontmatter with the body intact.
  }

  return { frontmatter, body };
}

/**
 * Return `source` with the leading `---` YAML frontmatter block stripped.
 * When no frontmatter block is present, `source` is returned unchanged.
 */
export function stripFrontmatter(source: string): string {
  return parseWorkflowFrontmatter(source).body;
}

/**
 * Serialize `frontmatter` as a `---`-fenced YAML block and concatenate `body`.
 * Produces a complete workflow file string.
 *
 * @example
 * ```ts
 * const file = serializeWorkflowFile({ name: "close-issues", description: "Fix issues" }, tsxSource);
 * // "---\nname: close-issues\n...\n---\n<TSX content>"
 * ```
 */
export function serializeWorkflowFile(
  frontmatter: WorkflowFrontmatter,
  body: string
): string {
  return `---\n${stringifyYaml(frontmatter)}---\n${body}`;
}

/**
 * Generate a `---`-fenced YAML frontmatter block string from a plain object.
 * Useful for scaffolding new workflow file headers.
 */
export function serializeWorkflowFrontmatter(
  fields: WorkflowFrontmatter
): string {
  return `---\n${stringifyYaml(fields)}---\n`;
}

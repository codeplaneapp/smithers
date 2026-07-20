/**
 * Parse and serialize frontmatter blocks from workflow files.
 *
 * Two formats are supported:
 * 1. Leading `---\n...\n---\n` YAML block — valid for companion `.md` files.
 * 2. Leading `/* ---\n...\n--- *\/` block comment — valid for executable
 *    `.ts`/`.tsx`/`.js`/`.mjs` files (raw `---` at top-of-file breaks JS syntax).
 *
 * Matches the elizaOS Skill frontmatter convention.
 *
 * @module
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** @typedef {import("./types.js").WorkflowFrontmatter} WorkflowFrontmatter */

/** Regex matching a leading `---` YAML frontmatter block (for .md companion files). */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

/**
 * Regex matching a leading block-comment frontmatter:
 *   `/* ---\n...yaml...\n--- *\/`
 * Captures the YAML content between the markers.
 */
const COMMENT_FRONTMATTER_RE = /^\/\*\s*---\r?\n([\s\S]*?)\r?\n---\s*\*\/([\s\S]*)$/;

/**
 * Parse the frontmatter block from `source`.
 *
 * Checks for block-comment frontmatter first (for executable files), then
 * falls back to `---`-fenced YAML (for companion `.md` files).
 *
 * Returns `{ frontmatter, body }` where `body` is the remainder of the file
 * after the frontmatter. When no frontmatter block is present, `frontmatter`
 * is an empty object and `body` equals `source`.
 *
 * @param {string} source
 * @returns {{ frontmatter: WorkflowFrontmatter; body: string }}
 */
export function parseWorkflowFrontmatter(source) {
  // Block-comment format is tried first (executable JS/TS files), then the
  // ---fenced YAML block (companion .md files or plain text). Both regexes
  // capture [1]=yaml and [2]=body.
  const match = source.match(COMMENT_FRONTMATTER_RE) ?? source.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, body: source };
  }

  const yamlBlock = match[1] ?? "";
  const body = match[2] ?? "";

  let frontmatter = /** @type {WorkflowFrontmatter} */ ({});
  try {
    const parsed = parseYaml(yamlBlock);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = /** @type {WorkflowFrontmatter} */ (parsed);
    }
  } catch {
    // Malformed YAML — return empty frontmatter with the body intact.
  }

  return { frontmatter, body };
}

/**
 * Return `source` with the leading frontmatter block stripped.
 * When no frontmatter block is present, `source` is returned unchanged.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripFrontmatter(source) {
  return parseWorkflowFrontmatter(source).body;
}

/**
 * Serialize `frontmatter` as a `---`-fenced YAML block and concatenate `body`.
 * Produces a complete workflow file string (suitable for companion `.md` files).
 *
 * @param {WorkflowFrontmatter} frontmatter
 * @param {string} body
 * @returns {string}
 */
export function serializeWorkflowFile(frontmatter, body) {
  return `---\n${stringifyYaml(frontmatter)}---\n${body}`;
}

/**
 * Generate a `---`-fenced YAML frontmatter block string from a plain object.
 * Useful for scaffolding new workflow file headers.
 *
 * @param {WorkflowFrontmatter} fields
 * @returns {string}
 */
export function serializeWorkflowFrontmatter(fields) {
  return `---\n${stringifyYaml(fields)}---\n`;
}

/**
 * Format a list of WorkflowDefinitions as a human-readable prompt string.
 *
 * Mirrors the pattern elizaOS uses to inject skill lists into system prompts.
 * Workflows with `disableModelInvocation: true` are omitted from the output.
 *
 * @module
 */

/** @typedef {import("./types.js").WorkflowDefinition} WorkflowDefinition */

/**
 * @typedef {{
 *   heading?: string;
 *   includeTags?: boolean;
 *   includeAliases?: boolean;
 * }} FormatWorkflowsOptions
 */

/**
 * Render a list of WorkflowDefinitions as a Markdown-ish prompt section.
 *
 * Workflows with `disableModelInvocation: true` are excluded so the LLM cannot
 * invoke them (matching elizaOS `formatSkillsForPrompt` behavior). Workflows
 * with `system: true` (internal plumbing) are excluded as well.
 *
 * @param {WorkflowDefinition[]} workflows
 * @param {FormatWorkflowsOptions} [options]
 * @returns {string}
 */
export function formatWorkflowsForPrompt(workflows, options = {}) {
  const {
    heading = "## Available Workflows",
    includeTags = true,
    includeAliases = true,
  } = options;

  const visible = workflows.filter((w) => !w.disableModelInvocation && !w.system);

  if (visible.length === 0) {
    return `${heading}\n\n(none)`;
  }

  const lines = [heading, ""];

  for (const w of visible) {
    const parts = [`- **${w.name}**: ${w.description || "(no description)"}`];

    if (includeTags && w.tags && w.tags.length > 0) {
      parts.push(`  tags: ${w.tags.join(", ")}`);
    }

    if (includeAliases && w.aliases && w.aliases.length > 0) {
      parts.push(`  aliases: ${w.aliases.join(", ")}`);
    }

    lines.push(parts.join("\n"));
  }

  return lines.join("\n");
}

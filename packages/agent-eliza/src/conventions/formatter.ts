/**
 * Format a list of WorkflowDefinitions as a human-readable prompt string.
 *
 * Mirrors the pattern elizaOS uses to inject skill lists into system prompts,
 * so an LLM can read the available workflows and invoke them by name.
 *
 * @module
 */

import type { WorkflowDefinition } from "./types.js";

export interface FormatWorkflowsOptions {
  /**
   * Heading to inject above the list.
   * Defaults to "## Available Workflows".
   */
  heading?: string;
  /**
   * Whether to include tags in the formatted output.
   * Defaults to `true`.
   */
  includeTags?: boolean;
  /**
   * Whether to include aliases in the formatted output.
   * Defaults to `true`.
   */
  includeAliases?: boolean;
}

/**
 * Render a list of WorkflowDefinitions as a Markdown-ish prompt section.
 *
 * @example
 * ```ts
 * const section = formatWorkflowsForPrompt(workflows);
 * // "## Available Workflows\n\n- **close-issues**: Fix open GitHub issues.\n..."
 * ```
 */
export function formatWorkflowsForPrompt(
  workflows: WorkflowDefinition[],
  options: FormatWorkflowsOptions = {}
): string {
  const {
    heading = "## Available Workflows",
    includeTags = true,
    includeAliases = true,
  } = options;

  if (workflows.length === 0) {
    return `${heading}\n\n(none)`;
  }

  const lines: string[] = [heading, ""];

  for (const w of workflows) {
    const parts: string[] = [`- **${w.name}**: ${w.description || "(no description)"}`];

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

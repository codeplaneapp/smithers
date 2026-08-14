import { ClaudeCodeAgent, CodexAgent } from "smthrs";
import type { BuildReviewPanelOptions } from "./BuildReviewPanelOptions";

/**
 * The review panel: multiple independent reviewers over the same implementation,
 * so a benchmark's review stage is a panel rather than a single judge. Codex is
 * welcome HERE (review only) — implementation is Claude-only — and pairs with
 * Opus for cross-family disagreement. Add Sonnet for a third vote.
 *
 * Returns the panel members; a harness runs them in `<Parallel>` and aggregates
 * their verdicts (see `review-panel.tsx`). Reviewers never implement.
 */
export function buildReviewPanel(options: BuildReviewPanelOptions = {}) {
  const common = options.cwd ? { cwd: options.cwd } : {};
  const members = [
    new CodexAgent({ ...common, model: options.codexModel ?? "gpt-5.5", skipGitRepoCheck: true }),
    new ClaudeCodeAgent({ ...common, model: options.opusModel ?? "claude-opus-4-8" }),
  ];
  if (options.includeSonnet) {
    members.push(new ClaudeCodeAgent({ ...common, model: options.sonnetModel ?? "claude-sonnet-5" }));
  }
  return members;
}

export type BuildReviewPanelOptions = {
  /** Codex reviewer model (default gpt-5.5). Review only — never implements. */
  codexModel?: string;
  /** Opus reviewer model (default claude-opus-4-8). */
  opusModel?: string;
  /** Add a third Sonnet reviewer. */
  includeSonnet?: boolean;
  sonnetModel?: string;
  /** Working directory for the reviewers (the benchmark checkout). */
  cwd?: string;
};

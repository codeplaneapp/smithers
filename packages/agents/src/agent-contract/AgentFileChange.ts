/**
 * Normalized cross-harness file-change record. See
 * `research/file-change-contract.md` for the design rationale.
 */
export type AgentFileChangeKind = "created" | "modified" | "deleted" | "renamed";

export type AgentFileChange = {
  path: string;
  kind: AgentFileChangeKind;
  /** Set when `kind === "renamed"`. */
  oldPath?: string;
  /** Full `git diff`-style unified patch, when available. */
  unifiedDiff?: string;
  /** Did the harness report the diff, or did we build it from tool input? */
  source: "reported" | "reconstructed";
};

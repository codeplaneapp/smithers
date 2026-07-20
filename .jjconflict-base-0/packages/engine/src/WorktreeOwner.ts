/**
 * Ownership record Smithers writes into a worktree's git admin directory
 * (`<git-common-dir>/worktrees/<name>/smithers-owner.json`) when the engine
 * creates it for a `<Worktree>` node. It lives in git's private admin area, not
 * in the checkout, so it can never dirty the worktree it describes, and git
 * deletes it along with the worktree registration on `git worktree prune`.
 *
 * Presence of this file is what makes a worktree reapable: worktrees a human
 * created by hand have no record and are never candidates.
 */
export type WorktreeOwner = {
  runId: string;
  workflowName?: string;
  /** "jj" workspaces need `jj workspace forget` before their directory goes away. */
  vcsType: "git" | "jj";
  /** jj workspace name, i.e. what `jj workspace forget` takes. */
  workspaceName?: string;
  baseBranch?: string;
  createdAtMs: number;
  /** Refreshed every time a task re-enters the worktree; the reap age filter reads this. */
  updatedAtMs: number;
};

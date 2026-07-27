/**
 * Filesystem probes used by the upward `smithers.db` walk.
 *
 * Tests inject fakes bounded to their own sandbox so the walk cannot escape
 * into ancestors outside their control: the real OS tmp root is shared across
 * concurrent processes and worktrees and is not guaranteed free of stray
 * `smithers.db` files, which makes an unbounded real-fs walk flaky.
 */
export type DbMarkerChecks = {
  fileExists: (path: string) => boolean;
};

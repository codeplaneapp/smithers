/**
 * @typedef {object} WorktreeSyncCache
 * @property {(repoKey: string) => boolean} shouldFetch
 * @property {(repoKey: string) => void} recordFetch
 * @property {(worktreePath: string, baseTipId: string | null | undefined) => boolean} shouldRebase
 * @property {(worktreePath: string, baseTipId: string | null | undefined) => void} recordRebase
 */
/**
 * In-memory TTL cache that lets `ensureWorktree` skip the network fetch and
 * base rebase it would otherwise pay before EVERY task that reuses a worktree.
 *
 * - `shouldFetch`/`recordFetch` are keyed by repo root: one successful fetch
 *   covers every worktree of that repo until `ttlMs` elapses.
 * - `shouldRebase`/`recordRebase` are keyed by worktree path: the rebase is
 *   skipped only while the base branch still points at the same tip the
 *   worktree was last rebased onto. An unknown tip (`null`/empty — resolution
 *   failed) always rebases and is never recorded, so failures fail open.
 * - A non-positive `ttlMs` disables all caching: every query returns true and
 *   nothing is recorded (today's fetch-and-rebase-every-time behavior).
 *
 * @param {{ ttlMs: number; nowMs?: () => number }} options `nowMs` is an injectable clock for tests.
 * @returns {WorktreeSyncCache}
 */
export function createWorktreeSyncCache({ ttlMs, nowMs = () => Date.now() }) {
  const enabled = Number.isFinite(ttlMs) && ttlMs > 0;
  /** @type {Map<string, number>} repo root -> timestamp of last successful fetch */
  const fetchedAtMs = new Map();
  /** @type {Map<string, string>} worktree path -> base tip it was last rebased onto */
  const rebasedTip = new Map();
  return {
    shouldFetch(repoKey) {
      if (!enabled) {
        return true;
      }
      const last = fetchedAtMs.get(repoKey);
      return last === undefined || nowMs() - last >= ttlMs;
    },
    recordFetch(repoKey) {
      if (!enabled) {
        return;
      }
      fetchedAtMs.set(repoKey, nowMs());
    },
    shouldRebase(worktreePath, baseTipId) {
      if (!enabled || !baseTipId) {
        return true;
      }
      return rebasedTip.get(worktreePath) !== baseTipId;
    },
    recordRebase(worktreePath, baseTipId) {
      if (!enabled || !baseTipId) {
        return;
      }
      rebasedTip.set(worktreePath, baseTipId);
    },
  };
}

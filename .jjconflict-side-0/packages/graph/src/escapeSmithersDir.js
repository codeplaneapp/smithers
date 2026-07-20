import { resolve, sep } from "node:path";

/**
 * A workflow file usually lives inside the workspace's own `.smithers/`
 * (e.g. `<repo>/.smithers/workflows/x.tsx`). Using its `dirname` as the run
 * root would make relative worktree paths resolve inside
 * `.smithers/workflows/`, spawning a NESTED `.smithers/workflows/.smithers`
 * workspace there (a real failure observed in the wild). Escape upward past
 * the first `.smithers` path segment so the root lands on the real workspace.
 *
 * Paths that contain no `.smithers` segment (or where `.smithers` is the very
 * first segment, i.e. no ancestor to escape to) are returned resolved and
 * unchanged.
 *
 * @param {string} dir
 * @returns {string}
 */
export function escapeSmithersDir(dir) {
  const resolved = resolve(dir);
  const parts = resolved.split(sep);
  const idx = parts.indexOf(".smithers");
  if (idx <= 0) {
    return resolved;
  }
  const escaped = parts.slice(0, idx).join(sep);
  // When `.smithers` sits directly under the root, the joined prefix is "" on
  // POSIX and a drive-relative "C:" on Windows; re-resolve with a trailing
  // separator so both land on the absolute filesystem root.
  return escaped ? resolve(escaped + sep) : sep;
}

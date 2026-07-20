import { execFileSync } from "node:child_process";

/**
 * Capture everything the agents changed in the checkout as a single git patch,
 * relative to the base commit. Includes new and deleted files (`git add -A`),
 * which is what `git apply -v` reconstructs inside the scoring container.
 *
 * @param {string} repoDir
 * @returns {string}
 */
export function extractPatch(repoDir) {
  execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
  // Diff the staged tree against the base commit; full index headers so the
  // patch is self-contained and applies with the harness's `git apply -p1`.
  const patch = execFileSync("git", ["diff", "--cached", "--binary", "HEAD"], {
    cwd: repoDir,
    stdio: "pipe",
    maxBuffer: 256 * 1024 * 1024,
  }).toString();
  return patch;
}

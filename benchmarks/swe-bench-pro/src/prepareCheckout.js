import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { config } from "./config.js";
import { ensureImage } from "./scorePatch.js";

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Materialize the instance's repository on the host, at `base_commit`, exactly
 * as it exists inside the canonical image — then sever all git history so the
 * agent cannot recover the fix.
 *
 * Why extract from the image instead of cloning upstream: the image is the
 * ground-truth environment (pinned deps, generated files, vendored modules), so
 * a patch produced against it applies cleanly when scored.
 *
 * Fairness steps:
 *   - reset the working tree to `base_commit` (the state the task starts from)
 *   - `git clean -fdx` to drop build artifacts baked into the image
 *   - delete `.git` and re-init a single base commit, so `git log`/`git show`
 *     reveal nothing about the future fix or the hidden test changes
 *
 * The agent therefore sees only: source at base_commit + the task spec. The
 * hidden tests are introduced solely inside the scoring container.
 *
 * @param {import("./loadInstances.js").SwebpInstance} instance
 * @param {(msg: string) => void} [log]
 * @returns {Promise<{ repoDir: string }>}
 */
export async function prepareCheckout(instance, log = () => {}) {
  const ok = await ensureImage(instance.dockerImage);
  if (!ok) throw new Error(`failed to obtain image ${instance.dockerImage}`);

  const repoDir = join(config.workDir, "checkouts", instance.instanceId);
  rmSync(repoDir, { recursive: true, force: true });
  mkdirSync(repoDir, { recursive: true });

  log(`[checkout] ${instance.instanceId}: copying /app from image…`);
  const cid = execFileSync(
    "docker",
    ["create", "--platform", config.dockerPlatform, instance.dockerImage],
    { stdio: "pipe" },
  )
    .toString()
    .trim();
  try {
    // `/app/.` copies the directory *contents* into repoDir.
    execFileSync("docker", ["cp", `${cid}:/app/.`, repoDir], { stdio: "pipe", maxBuffer: 512 * 1024 * 1024 });
  } finally {
    execFileSync("docker", ["rm", "-f", cid], { stdio: "pipe" });
  }

  log(`[checkout] ${instance.instanceId}: pinning base_commit ${instance.baseCommit.slice(0, 10)} and stripping history…`);
  git(repoDir, ["reset", "--hard", instance.baseCommit]);
  git(repoDir, ["clean", "-fdx"]);
  git(repoDir, ["checkout", "--detach", instance.baseCommit]);

  // Sever history: re-init so the only commit is the base state.
  rmSync(join(repoDir, ".git"), { recursive: true, force: true });
  git(repoDir, ["init", "-q"]);
  git(repoDir, ["config", "user.email", "bench@smithers.local"]);
  git(repoDir, ["config", "user.name", "swe-bench-pro"]);
  git(repoDir, ["config", "commit.gpgsign", "false"]);
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-q", "--no-verify", "-m", "base"]);

  return { repoDir };
}

/**
 * Asserts that patch capture reports the agent's edits and nothing else.
 *
 *   node fixtures/check-capture.mjs
 *
 * The rig's two historical contaminants are reproduced here with plain git, no
 * docker and no dataset:
 *
 *   1. The official images mutate tracked files in `pre_install`
 *      (sphinx-doc__sphinx-11445 seds `-rA` into `tox.ini`). A diff against the
 *      base commit reports that churn as the agent's, and it reverse-applies at
 *      grading, which voided every sphinx verdict from waves 2 through 4.
 *   2. The flows durability snapshot writes the whole working tree into git's
 *      index, so scratch the agent created is tracked by capture time. Wave 3
 *      shipped `.tmp_init_collect_repro/` with an `assert False` in it.
 *
 * Both shapes of image are covered: one that commits its `pre_install` churn
 * (what the sphinx image does) and one that leaves it in the worktree.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-capture-"))

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
const run = (script, ...args) =>
  execFileSync(join(root, script), args, { cwd: root, encoding: "utf8" }).trim()

/** A testbed the way an official image ships one: a base commit, then churn. */
const makeTestbed = (name, { commitChurn }) => {
  const work = join(temporary, name)
  mkdirSync(work, { recursive: true })
  git(work, "init", "--quiet")
  git(work, "config", "user.name", "image")
  git(work, "config", "user.email", "image@localhost")
  writeFileSync(join(work, "src.py"), "value = 1\n")
  writeFileSync(join(work, "tox.ini"), "commands=\n    pytest --durations 25\n")
  git(work, "add", "-A")
  git(work, "commit", "--quiet", "-m", "base")
  const base = git(work, "rev-parse", "HEAD")
  writeFileSync(join(work, "tox.ini"), "commands=\n    pytest -rA --durations 25\n")
  if (commitChurn) {
    git(work, "add", "-A")
    git(work, "commit", "--quiet", "-m", "pre_install")
  }
  return { work, base }
}

try {
  for (const commitChurn of [true, false]) {
    const label = commitChurn ? "churn committed" : "churn unstaged"
    const { work, base } = makeTestbed(commitChurn ? "committed" : "unstaged", { commitChurn })

    const captureBase = run("lib/snapshot-base.sh", work)
    assert.match(captureBase, /^[0-9a-f]{40}$/, `${label}: capture base is a commit`)

    // No agent runs. The captured patch must be empty: the image's own churn is
    // in the capture base, so it cancels.
    const empty = join(temporary, `${commitChurn}-empty.patch`)
    run("lib/capture-patch.sh", work, empty)
    assert.equal(readFileSync(empty, "utf8"), "", `${label}: a run with no agent captures an empty patch`)

    // Now the agent: one real edit, plus scratch, plus the durability sweep that
    // puts everything the working tree holds into git's index.
    writeFileSync(join(work, "src.py"), "value = 2\n")
    mkdirSync(join(work, ".tmp_init_collect_repro"), { recursive: true })
    writeFileSync(join(work, ".tmp_init_collect_repro/test_repro.py"), "assert False\n")
    git(work, "add", "-A")

    const patchPath = join(temporary, `${commitChurn}.patch`)
    run("lib/capture-patch.sh", work, patchPath)
    const patch = readFileSync(patchPath, "utf8")

    assert.match(patch, /^diff --git a\/src\.py b\/src\.py$/m, `${label}: the agent's edit is captured`)
    assert.match(patch, /^\+value = 2$/m, `${label}: the edit's content is captured`)
    assert.doesNotMatch(patch, /tox\.ini/, `${label}: the image's pre_install churn is not captured`)
    assert.doesNotMatch(patch, /-rA/, `${label}: the image's pre_install churn is not captured`)
    assert.doesNotMatch(patch, /_init_collect_repro/, `${label}: agent scratch is not captured`)
    assert.doesNotMatch(patch, /assert False/, `${label}: agent scratch is not captured`)
    assert.equal(patch.split("diff --git ").length - 1, 1, `${label}: exactly one file section`)

    // What was dropped is recorded, so a wave can see a file it meant to keep.
    const dropped = readFileSync(`${patchPath}.untracked`, "utf8").split("\n").filter(Boolean)
    assert.deepEqual(dropped, [".tmp_init_collect_repro/test_repro.py"], `${label}: the dropped files are listed`)

    // The hunk context comes from the pristine post-install tree, not from the
    // agent, and the capture base is that tree — churn included, so it cancels.
    assert.match(patch, /^-value = 1$/m, `${label}: the hunk is against the pre-agent content`)
    assert.equal(
      git(work, "show", `${captureBase}:tox.ini`),
      "commands=\n    pytest -rA --durations 25",
      `${label}: the capture base carries the image's pre_install churn`
    )
    assert.equal(git(work, "show", `${base}:tox.ini`), "commands=\n    pytest --durations 25", `${label}: the base commit does not`)
  }

  // A workspace with no capture base is refused, not captured against the base
  // commit behind the operator's back.
  const stale = join(temporary, "stale")
  mkdirSync(stale, { recursive: true })
  git(stale, "init", "--quiet")
  git(stale, "config", "user.name", "image")
  git(stale, "config", "user.email", "image@localhost")
  writeFileSync(join(stale, "src.py"), "value = 1\n")
  git(stale, "add", "-A")
  git(stale, "commit", "--quiet", "-m", "base")
  const refused = execFileSync(
    "bash",
    ["-c", `"${join(root, "lib/capture-patch.sh")}" "${stale}" "${join(temporary, "stale.patch")}" 2>&1; echo "exit:$?"`],
    { encoding: "utf8" }
  )
  assert.match(refused, /exit:3/, "a workspace with no capture base exits 3")
  assert.match(refused, /predates the capture fix/, "the refusal says why")
  assert.equal(existsSync(join(temporary, "stale.patch")), false, "the refusal writes no patch")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

console.log("check-capture.mjs: capture reports the agent's edits and nothing else.")

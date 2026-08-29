/**
 * Writes the codex-baseline prompt for one instance.
 *
 *   node lib/write-prompt-codex.mjs <dataset.json> <instance_id> <container> <test-command> [interpreter]
 *
 * Deliberately byte-close to write-flow.mjs: same issue text, same environment
 * explanation, same test command, same rules and budget framing. The only
 * removals are flows-specific tool guidance — the `write` flow, and the Jujutsu
 * colocation that only the flows CLI creates — because codex brings its own
 * tools and its own workspace, which is exactly the variable this baseline
 * isolates.
 *
 * **The test command is not flows-specific and is never dropped.** It is the
 * repository's own runner, read from the pinned evaluator's
 * `MAP_REPO_VERSION_TO_SPECS` by `lib/test-command.py`, and it is environment
 * teaching of the same kind as "run it in the container": Django ships no
 * pytest module and Sphinx runs under tox, so a baseline told to verify with
 * `python -m pytest` cannot verify anything on those instances while the harness
 * under test can. Between 2026-08-19 and wave 11 exactly that held, and the
 * codex numbers from those waves are not comparable on `django__django-16612`
 * or `sphinx-doc__sphinx-11445`. `fixtures/check-prompts.mjs` pins the symmetry
 * so it cannot drift back.
 *
 * **Neither is the interpreter.** How this image runs the project's Python is
 * read off the container by `lib/interpreter.sh`, and it is environment
 * teaching of the same kind for the same reason: an agent that knows which
 * Python owns the repository's dependencies and one that does not are not the
 * same measurement.
 */
import { readFileSync } from "node:fs"

const [, , datasetPath, instanceId, container, testCommand, interpreter] = process.argv
if (testCommand === undefined || testCommand.trim() === "") {
  console.error("write-prompt-codex.mjs: no test command given; see lib/test-command.py")
  process.exit(1)
}
const all = JSON.parse(readFileSync(datasetPath, "utf8"))
const instance = all.find((row) => row.instance_id === instanceId)
if (instance === undefined) {
  console.error(`unknown instance ${instanceId}`)
  process.exit(1)
}

// Byte-identical to the bullet lib/write-flow.mjs renders; see the note there.
const interpreterBullet = interpreter === undefined || interpreter.trim() === "" ? "" : `
- This image runs the project's Python as \`${interpreter.trim()}\`. The
  repository's dependencies are installed against that interpreter; a bare
  \`python\` or \`python3\` resolves to a different one, and importing the
  project with it fails.`

const body = `You are working in a checkout of ${instance.repo} at commit ${instance.base_commit}.
The working directory is the repository root.

Resolve the issue below by editing the repository's source files.

## Your environment

Your shell runs on a macOS host with BSD userland. The repository's own Linux
environment and Python interpreter are in a container that has this exact
directory mounted at /testbed, so a file you change here changes there
immediately, and vice versa.

- Run anything that touches the project — imports, scripts, tests — inside the
  container:

      docker exec ${container} bash -lc 'cd /testbed && <command>'

  GNU grep, GNU sed, and the project's dependencies are all available there.
  \`sed -i\` on the host is BSD sed and will not behave like GNU sed; run it
  through docker exec, or avoid it.${interpreterBullet}
- This repository runs its tests with \`${testCommand}\`, which takes the test
  paths to run as trailing arguments. It is the runner this project actually
  uses: other runners are not necessarily installed here.

## How to work

Reproduce the problem first, find the responsible code, make the smallest correct
fix in the library source, and verify it by running the relevant existing tests in
the container. Do not modify tests to make them pass, and do not add new test
files. Do not commit; leave your changes in the working tree.

Always check the exit code and output of a command before believing it worked. A
command that exits non-zero did not do what you asked.

Finish only when you have applied the fix to the source files and confirmed it
by running code.

## Issue

${instance.problem_statement}
`

process.stdout.write(body)

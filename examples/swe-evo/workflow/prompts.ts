/**
 * Prompt builders for the SWE-EVO workflow.
 *
 * Fairness rule baked in here: the agent is given ONLY the release-note
 * specification (the SWE-EVO `problem_statement`) and the repository at the
 * previous release. It never sees the hidden tests, the FAIL_TO_PASS /
 * PASS_TO_PASS lists, or the gold patch. Editing tests is explicitly forbidden
 * (and the scorer reverts test files anyway).
 */

import type { Instance } from "./harness";

const RULES = `Rules:
- Explore the codebase first to understand the modules involved before editing.
- Implement the described behavior with minimal, correct, idiomatic changes that
  match the existing code style and conventions of this project.
- Make the change complete and self-consistent across ALL affected source files.
- Do NOT add, modify, or delete any test files (paths containing tests/ or named
  test_*.py / *_test.py). Your work is validated by a hidden test suite; editing
  tests cannot help and will be discarded.
- Do not bump version numbers or edit changelog/release-note files unless the
  behavior described literally requires it.
- Prefer fixing root causes over special-casing. Do not leave TODOs.`;

export function implementPrompt(instance: Instance): string {
  return `You are evolving the \`${instance.repo}\` codebase from one release to the next.

The repository in your working directory is checked out at the PREVIOUS release
(\`${instance.start_version ?? instance.base_commit}\`, commit ${instance.base_commit}).
Implement the changes described in the following release specification so the new
release's behavior is realized in the code.

==================== RELEASE SPECIFICATION (${instance.end_version ?? "next release"}) ====================
${instance.problem_statement}
====================================================================================

${RULES}

Apply your edits directly to the files in the working directory. When finished,
report a short summary and the list of source files you changed.`;
}

export function refinePrompt(instance: Instance): string {
  return `You are a senior reviewer completing an in-progress implementation in the
\`${instance.repo}\` codebase. Another engineer has already attempted to implement
the release specification below; their uncommitted edits are in the working
directory (run \`git diff\` to review them).

==================== RELEASE SPECIFICATION (${instance.end_version ?? "next release"}) ====================
${instance.problem_statement}
====================================================================================

Your job:
- Review the current changes against the specification.
- Find and fix bugs, missing edge cases, incomplete coverage across files,
  incorrect logic, or anything that would make the new behavior wrong or partial.
- If you find the implementation already correct and complete, make no changes.

${RULES}

Apply any fixes directly to the files. When finished, report what you changed (or
confirm the implementation was already correct and complete).`;
}

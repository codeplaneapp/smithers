// smithers-display-name: Rename dependents
// smithers-source: one-off — for every repo that references the old npm name
// smithers-orchestrator, a Codex Luna lane clones it, renames to smthrs, proves
// `git grep smithers-orchestrator` is clean, Codex Sol reviews the diff, and a
// DRAFT PR is opened. Lanes run in parallel, one per repo.
/** @jsxImportSource smthrs */
import { ClaudeCodeAgent, UI, createSmithers } from "smthrs";
import { z } from "zod/v4";
import { codexFirst } from "../lib/codexAccounts";

const OLD_NAME = "smithers" + "-orchestrator"; // split so this workflow never matches its own audit greps
const NEW_NAME = "smthrs";

const renameSchema = z.object({
  repo: z.string(),
  status: z.enum(["renamed", "no-hits", "blocked"]).default("renamed"),
  branch: z.string().default(""),
  clonePath: z.string().default(""),
  filesChanged: z.number().int().default(0),
  grepClean: z.boolean().default(false),
  grepOutput: z.string().default(""),
  notes: z.string().default(""),
});

const reviewSchema = z.object({
  repo: z.string(),
  approved: z.boolean(),
  feedback: z.string().default(""),
  issues: z
    .array(
      z.object({
        severity: z.enum(["critical", "major", "minor", "nit"]).default("nit"),
        file: z.string().default(""),
        description: z.string().default(""),
      }),
    )
    .default([]),
});

const prSchema = z.object({
  repo: z.string(),
  prUrl: z.string().nullable().default(null),
  draft: z.boolean().default(true),
  skipped: z.boolean().default(false),
  summary: z.string().default(""),
});

const inputSchema = z.object({
  repos: z.array(z.string()).min(1),
  maxConcurrency: z.number().int().min(1).max(8).default(4),
});

const { Workflow, Task, Sequence, Parallel, smithers, outputs } = createSmithers({
  input: inputSchema,
  rename: renameSchema,
  review: reviewSchema,
  pr: prSchema,
});

const luna = codexFirst(
  {
    model: "gpt-5.6-luna",
    config: { model_reasoning_effort: "medium" },
    sandbox: "danger-full-access",
    dangerouslyBypassApprovalsAndSandbox: true,
    skipGitRepoCheck: true,
  },
  [new ClaudeCodeAgent({ model: "claude-sonnet-5" })],
);

const sol = codexFirst(
  {
    model: "gpt-5.6-sol",
    sandbox: "danger-full-access",
    dangerouslyBypassApprovalsAndSandbox: true,
    skipGitRepoCheck: true,
  },
  [new ClaudeCodeAgent({ model: "claude-opus-4-8" })],
);

const RENAME_TIMEOUT_MS = 30 * 60_000;
const REVIEW_TIMEOUT_MS = 20 * 60_000;
const PR_TIMEOUT_MS = 15 * 60_000;

const laneId = (repo: string) => repo.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();

const renamePrompt = (repo: string) =>
  `
Rename every reference to the npm package "${OLD_NAME}" to "${NEW_NAME}" in the GitHub repo ${repo}.

Steps (do them exactly):
1. Clone into a fresh directory: \`gh repo clone ${repo} /tmp/rename-smthrs/${laneId(repo)} -- --depth 50\` and cd there.
2. Create a branch: \`git checkout -b rename-smthrs\`.
3. Find every reference with \`git grep -l '${OLD_NAME}'\` (git grep, NOT rg — rg silently skips files containing NUL bytes). Rename with \`git grep -lz '${OLD_NAME}' | xargs -0 perl -pi -e 's/${OLD_NAME}/${NEW_NAME}/g'\`.
   Notes: the whole string "${OLD_NAME}" becomes "${NEW_NAME}", including the scoped form "@${OLD_NAME}/x" -> "@${NEW_NAME}/x". The CLI bin name "smithers" and prose "Smithers" stay unchanged.
4. If the repo has a package.json depending on the old name, keep the version range but point it at "${NEW_NAME}". Regenerate lockfiles ONLY with the repo's own package manager if a lockfile exists (pnpm-lock.yaml -> pnpm install --no-frozen-lockfile; bun.lock -> bun install --lockfile-only; package-lock.json -> npm install --package-lock-only). If install fails because ${NEW_NAME} is not yet published to npm, skip lockfile regeneration and say so in notes.
5. MANDATORY VERIFICATION GATE: run \`git grep -n '${OLD_NAME}'\` — it MUST output nothing. Put the literal (empty) output in grepOutput and set grepClean accordingly. If any hit remains, fix it and re-run; never report grepClean=true without the empty grep.
6. Commit: \`git commit -am "rename ${OLD_NAME} to ${NEW_NAME}"\`. Do NOT push yet.
If \`git grep -l '${OLD_NAME}'\` finds nothing at step 3, set status="no-hits" and stop (no commit).
Set repo="${repo}", clonePath, branch, filesChanged from \`git diff --stat HEAD~1\`.
`.trim();

const reviewPrompt = (repo: string, clonePath: string) =>
  `
Review the rename commit in ${clonePath} (repo ${repo}, branch rename-smthrs, top commit).

Check:
- \`git grep -n '${OLD_NAME}'\` yourself — must be empty; a single hit is a critical issue.
- \`git show --stat HEAD\` and read the diff: only name changes, no logic changes, no corrupted files (watch for truncated lines and broken JSON).
- Lockfile changes (if any) match the manifest change and nothing else.
- Nothing renamed that should not be: URLs to the OLD repo history are fine to change, but do not rewrite CHANGELOG semantics claims.
Set approved=true only if you would merge it. Set repo="${repo}".
`.trim();

const prPrompt = (repo: string, clonePath: string, review: string) =>
  `
Open a DRAFT pull request for the rename branch in ${clonePath} (repo ${repo}).

1. cd ${clonePath}
2. If you lack push permission to ${repo}, fork first: \`gh repo fork --remote\` and push there; otherwise \`git push -u origin rename-smthrs\`.
3. \`gh pr create --draft --title "Rename ${OLD_NAME} to ${NEW_NAME}" --body "<body>"\` where the body explains: the package was renamed on npm to ${NEW_NAME} with no compat alias, what was swept, that \\\`git grep ${OLD_NAME}\\\` is clean, and includes this reviewer note: ${review}. End the body with the line: 🤖 Generated with [Claude Code](https://claude.com/claude-code)
4. Set repo="${repo}" and prUrl to the created PR URL.
If the PR cannot be created (permissions, archived repo), set skipped=true with the reason in summary.
`.trim();

export default smithers((ctx) => {
  return (
    <Workflow name="rename-dependents">
      <UI entry="../ui/rename-dependents.tsx" title={"Rename dependents"} />
      <Parallel maxConcurrency={ctx.input.maxConcurrency}>
        {ctx.input.repos.map((repo) => {
          const id = laneId(repo);
          const rename = ctx.outputMaybe(outputs.rename, { nodeId: `rename-${id}` });
          const review = ctx.outputMaybe(outputs.review, { nodeId: `review-${id}` });
          return (
            <Sequence key={id}>
              <Task id={`rename-${id}`} output={outputs.rename} agent={luna} retries={2} timeoutMs={RENAME_TIMEOUT_MS}>
                {renamePrompt(repo)}
              </Task>
              {rename && rename.status === "renamed" && rename.grepClean ? (
                <Task id={`review-${id}`} output={outputs.review} agent={sol} retries={2} timeoutMs={REVIEW_TIMEOUT_MS}>
                  {reviewPrompt(repo, rename.clonePath)}
                </Task>
              ) : null}
              {rename && review?.approved ? (
                <Task id={`pr-${id}`} output={outputs.pr} agent={luna} retries={2} timeoutMs={PR_TIMEOUT_MS}>
                  {prPrompt(repo, rename.clonePath, review.feedback || "approved")}
                </Task>
              ) : null}
            </Sequence>
          );
        })}
      </Parallel>
    </Workflow>
  );
});

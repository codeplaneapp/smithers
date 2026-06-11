import type { PullRequestTarget } from "./resolvePullRequest";
import { runGh } from "./runGh";

/** Paths changed in the PR, for filtering which findings can anchor inline. */
export async function listPullRequestFiles(repoDir: string, pr: PullRequestTarget): Promise<Set<string>> {
  const raw = await runGh(repoDir, [
    "api",
    "--paginate",
    `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/files`,
    "--jq",
    ".[].filename",
  ]);
  return new Set(raw.split("\n").map((line) => line.trim()).filter(Boolean));
}

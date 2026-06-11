import { runGh } from "./runGh";

export type PullRequestTarget = {
  owner: string;
  repo: string;
  number: number;
  url: string;
  baseRefName: string;
  headRefName: string;
  headSha: string;
};

/** Resolve a PR (number or URL) to its coordinates via the gh CLI. */
export async function resolvePullRequest(repoDir: string, prRef: string): Promise<PullRequestTarget> {
  const raw = await runGh(repoDir, [
    "pr",
    "view",
    prRef,
    "--json",
    "number,url,baseRefName,headRefName,headRefOid",
  ]);
  const data = JSON.parse(raw) as {
    number: number;
    url: string;
    baseRefName: string;
    headRefName: string;
    headRefOid: string;
  };
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(data.url);
  if (!match) throw new Error(`cannot parse owner/repo from PR url: ${data.url}`);
  return {
    owner: match[1],
    repo: match[2],
    number: data.number,
    url: data.url,
    baseRefName: data.baseRefName,
    headRefName: data.headRefName,
    headSha: data.headRefOid,
  };
}

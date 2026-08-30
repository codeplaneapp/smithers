import { runGh as defaultRunGh } from "./runGh.ts";

export type PullRequestTarget = {
  owner: string;
  repo: string;
  number: number;
  url: string;
  baseRefName: string;
  headRefName: string;
  headSha: string;
  title: string;
  body: string;
};

/** Resolve a PR (number or URL) to its coordinates via the gh CLI. */
export async function resolvePullRequest(
  repoDir: string,
  prRef: string,
  runGh: typeof defaultRunGh = defaultRunGh,
): Promise<PullRequestTarget> {
  const raw = await runGh(repoDir, [
    "pr",
    "view",
    prRef,
    "--json",
    "number,url,baseRefName,headRefName,headRefOid,title,body",
  ]);
  const data = JSON.parse(raw) as {
    number: number;
    url: string;
    baseRefName: string;
    headRefName: string;
    headRefOid: string;
    title?: string;
    body?: string;
  };
  // Match on the URL path, not a hardcoded github.com host, so GitHub
  // Enterprise PR URLs resolve too.
  let path = "";
  try {
    path = new URL(data.url).pathname;
  } catch {
    // Unparseable URL: fall through to the error below.
  }
  const match = /\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(path);
  if (!match) throw new Error(`cannot parse owner/repo from PR url: ${data.url}`);
  return {
    owner: match[1],
    repo: match[2],
    number: data.number,
    url: data.url,
    baseRefName: data.baseRefName,
    headRefName: data.headRefName,
    headSha: data.headRefOid,
    title: data.title ?? "",
    body: data.body ?? "",
  };
}

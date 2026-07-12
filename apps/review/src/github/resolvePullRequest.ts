import { runGh as defaultRunGh } from "./runGh";

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
  state: "open" | "closed" | "merged";
  draft: boolean;
};

/** Resolve a PR (number or URL) to its coordinates via the gh CLI. */
export async function resolvePullRequest(
  repoDir: string,
  prRef: string,
  runGh: typeof defaultRunGh = defaultRunGh,
): Promise<PullRequestTarget> {
  if (typeof prRef !== "string" || prRef.length < 1 || prRef.length > 2_048 || /[\u0000-\u001f\u007f]/.test(prRef)) {
    throw new Error("pull request reference is invalid or oversized");
  }
  const raw = await runGh(repoDir, [
    "pr",
    "view",
    prRef,
    "--json",
    "number,url,baseRefName,headRefName,headRefOid,title,body,state,isDraft",
  ]);
  let data: {
    number: number;
    url: string;
    baseRefName: string;
    headRefName: string;
    headRefOid: string;
    title?: string;
    body?: string;
    state: "OPEN" | "CLOSED" | "MERGED";
    isDraft: boolean;
  };
  try { data = JSON.parse(raw) as typeof data; }
  catch { throw new Error("gh returned invalid pull request JSON"); }
  if (!data || typeof data !== "object" || Array.isArray(data)
    || !Number.isSafeInteger(data.number) || data.number < 1
    || typeof data.url !== "string" || data.url.length < 1 || data.url.length > 2_048
    || typeof data.baseRefName !== "string" || data.baseRefName.length < 1 || data.baseRefName.length > 256 || /[\u0000-\u001f\u007f]/.test(data.baseRefName)
    || typeof data.headRefName !== "string" || data.headRefName.length < 1 || data.headRefName.length > 256 || /[\u0000-\u001f\u007f]/.test(data.headRefName)
    || typeof data.headRefOid !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(data.headRefOid)
    || (data.state !== "OPEN" && data.state !== "CLOSED" && data.state !== "MERGED")
    || typeof data.isDraft !== "boolean"
    || (data.title !== undefined && (typeof data.title !== "string" || data.title.length > 20_000 || data.title.includes("\0")))
    || (data.body !== undefined && (typeof data.body !== "string" || data.body.length > 200_000 || data.body.includes("\0")))) {
    throw new Error("gh returned an invalid pull request payload");
  }
  // Match on the URL path, not a hardcoded github.com host, so GitHub
  // Enterprise PR URLs resolve too.
  let url: URL;
  try {
    url = new URL(data.url);
  } catch {
    throw new Error("gh returned an invalid pull request URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("gh returned an invalid pull request URL");
  }
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
  if (!match || Number(match[3]) !== data.number || match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === "..") {
    throw new Error("cannot parse owner/repo from pull request URL");
  }
  return {
    owner: match[1],
    repo: match[2],
    number: data.number,
    url: url.toString(),
    baseRefName: data.baseRefName,
    headRefName: data.headRefName,
    headSha: data.headRefOid,
    title: data.title ?? "",
    body: data.body ?? "",
    state: data.state.toLowerCase() as PullRequestTarget["state"],
    draft: data.isDraft,
  };
}

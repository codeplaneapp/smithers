/**
 * Resolve the "last publish" baseline for review-since-publish.
 *
 * We always tag (`v<version>`) before publishing, so the published npm version
 * is the authoritative anchor: ask npm what is live, then resolve that tag in
 * this checkout. Everything after that tag — committed AND uncommitted — is the
 * surface under review.
 */

export type PublishBaseline = {
  packageName: string;
  publishedVersion: string;
  tag: string;
  tagCommit: string;
  head: string;
  commitCount: number;
  diffStat: string;
  changedFiles: string[];
  untrackedFiles: string[];
  commits: string[];
  notes: string[];
};

async function run(cmd: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out.trim(), err: err.trim() };
}

async function git(args: string[], cwd: string): Promise<string> {
  const { code, out, err } = await run(["git", ...args], cwd);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err || out}`);
  return out;
}

const lines = (s: string): string[] =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * Generated/derived artifacts. Reviewing them wastes the panel's budget: they
 * are regenerated from sources that ARE reviewed, and a lockfile or a 60k-line
 * llms bundle drowns out real defects.
 */
export const DEFAULT_EXCLUDES = [
  "pnpm-lock.yaml",
  "bun.lock",
  "**/*.generated.*",
  "**/llms-full.txt",
  "**/llms-core.txt",
  "**/llms.txt",
];

export async function resolvePublishBaseline(opts: {
  repoRoot: string;
  packageName?: string;
  /** Force a baseline tag instead of deriving it from the published version. */
  tagOverride?: string;
  maxFiles?: number;
  /** Path globs kept out of the review surface; defaults to {@link DEFAULT_EXCLUDES}. */
  excludes?: string[];
}): Promise<PublishBaseline> {
  const repoRoot = opts.repoRoot;
  const excludes = (opts.excludes ?? DEFAULT_EXCLUDES).map((p) => `:(exclude)${p}`);
  const packageName = opts.packageName ?? "smithers-orchestrator";
  const maxFiles = opts.maxFiles ?? 4000;
  const notes: string[] = [];

  let publishedVersion = "";
  const npm = await run(["npm", "view", packageName, "version"], repoRoot);
  if (npm.code === 0 && npm.out) {
    publishedVersion = npm.out.split("\n").pop()!.trim();
  } else {
    notes.push(`npm view ${packageName} version failed (${npm.err || npm.code}); falling back to the newest git tag.`);
  }

  const allTags = lines(await git(["tag", "--sort=-creatordate"], repoRoot));
  let tag = opts.tagOverride ?? (publishedVersion ? `v${publishedVersion}` : "");

  if (tag && !allTags.includes(tag)) {
    notes.push(`Tag ${tag} for published version ${publishedVersion} is not in this checkout.`);
    tag = "";
  }
  if (!tag) {
    tag = allTags[0] ?? "";
    if (tag) notes.push(`Using newest tag ${tag} as the baseline.`);
  }
  if (!tag) throw new Error("No git tags found; cannot establish a last-publish baseline.");
  if (!publishedVersion) publishedVersion = tag.replace(/^v/, "");

  const tagCommit = await git(["rev-parse", `${tag}^{commit}`], repoRoot);
  const head = await git(["rev-parse", "HEAD"], repoRoot);

  // `git diff <tag>` (no ..HEAD) compares the tag against the WORKING TREE, so
  // uncommitted fixes made by this workflow are part of the next review round.
  const pathspec = excludes.length ? ["--", ...excludes] : [];
  const diffStat = await git(["diff", "--stat", tag, ...pathspec], repoRoot);
  const changedFiles = lines(await git(["diff", "--name-only", tag, ...pathspec], repoRoot)).slice(0, maxFiles);
  const untrackedFiles = lines(
    await git(["ls-files", "--others", "--exclude-standard", ...(excludes.length ? excludes : [])], repoRoot),
  ).slice(0, maxFiles);
  const commits = lines(await git(["log", "--oneline", "--no-decorate", `${tag}..HEAD`], repoRoot));

  return {
    packageName,
    publishedVersion,
    tag,
    tagCommit,
    head,
    commitCount: commits.length,
    diffStat: diffStat.split("\n").slice(-1).join("\n") || diffStat,
    changedFiles,
    untrackedFiles,
    commits,
    notes,
  };
}

/** Compact briefing every panelist receives verbatim. */
export function baselineBriefing(b: PublishBaseline, opts?: { maxFileLines?: number }): string {
  const maxFileLines = opts?.maxFileLines ?? 400;
  const shown = b.changedFiles.slice(0, maxFileLines);
  const more = b.changedFiles.length - shown.length;
  return [
    `Last published version of \`${b.packageName}\` on npm: **${b.publishedVersion}**`,
    `Baseline git tag: **${b.tag}** (${b.tagCommit.slice(0, 12)})`,
    `Current HEAD: ${b.head.slice(0, 12)} — ${b.commitCount} commits since the tag, plus uncommitted working-tree changes.`,
    ``,
    `Diff totals (\`git diff --stat ${b.tag}\`): ${b.diffStat}`,
    ``,
    `Changed files (\`git diff --name-only ${b.tag}\`)${more > 0 ? `, first ${shown.length} of ${b.changedFiles.length}` : ""}:`,
    "```",
    shown.join("\n"),
    more > 0 ? `... and ${more} more` : "",
    "```",
    b.untrackedFiles.length
      ? `Untracked files (${b.untrackedFiles.length}): ${b.untrackedFiles.slice(0, 60).join(", ")}`
      : "No untracked files.",
    b.notes.length ? `\nBaseline notes:\n${b.notes.map((n) => `- ${n}`).join("\n")}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

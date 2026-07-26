import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CollectedContext, Probe } from "./schemas";

/**
 * The dry, commit-level changelog that lives at the repo root and is hosted
 * only on GitHub (never on the docs site). The narrative changelog at
 * docs/changelogs/<version>.mdx is the tour; this file is the complete list.
 * Deterministic by design: agents draft prose, code enumerates commits.
 */

const CATEGORIES: Array<{ title: string; match: RegExp }> = [
  { title: "Features", match: /^✨/ },
  { title: "Security fixes", match: /^🔒/ },
  { title: "Bug fixes", match: /^🐛/ },
  { title: "Performance", match: /^(⚡️|⚡)/ },
  { title: "Refactoring", match: /^♻️/ },
  { title: "Tests", match: /^✅/ },
  { title: "Documentation", match: /^📝/ },
];

function repoUrl(): string {
  try {
    const raw = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();
    return raw.replace(/\.git$/, "").replace(/^git@github\.com:/, "https://github.com/");
  } catch {
    return "https://github.com/smithersai/smithers";
  }
}

const escapeMd = (s: string) => s.replace(/</g, "\\<").replace(/>/g, "\\>");

const TOKEN_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "in",
  "on",
  "for",
  "to",
  "with",
  "from",
  "into",
  "its",
  "their",
  "when",
  "after",
  "before",
  "are",
  "is",
  "be",
  "now",
  "not",
  "no",
  "that",
  "this",
  "via",
  "by",
  "as",
  "at",
  "it",
  "up",
  "out",
  "only",
  "also",
  "add",
  "adds",
  "added",
  "fix",
  "fixes",
  "fixed",
  "make",
  "makes",
  "keep",
  "keeps",
  "use",
  "uses",
  "support",
]);

type CommitEntry = { sha: string; subject: string; scope: string; tokens: Set<string> };

function subjectTokens(subject: string): Set<string> {
  // Issue refs (#1028) stay as tokens: sibling changes that differ only by
  // integration and issue number are distinct changes, not one reland.
  return new Set(
    subject
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !TOKEN_STOPWORDS.has(word)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection || 1);
}

/**
 * Merge commits that belong to the same logical change (relands, retries,
 * follow-up fixes, stacked lanes) into one changelog entry with every sha
 * linked. Deliberately conservative: candidates need the same category and
 * scope, and high token overlap with the cluster's FIRST member. Matching
 * against any member at a lower threshold chain-drifts and lumps unrelated
 * changes together (observed on the 0.28.0 range).
 */
function clusterCommits(commits: CommitEntry[]): CommitEntry[][] {
  const clusters: CommitEntry[][] = [];
  for (const entry of commits) {
    const home = clusters.find(
      (cluster) => cluster[0].scope === entry.scope && jaccard(cluster[0].tokens, entry.tokens) >= 0.65,
    );
    if (home) home.push(entry);
    else clusters.push([entry]);
  }
  return clusters;
}

function renderCluster(cluster: CommitEntry[], repo: string): string {
  // git log is newest-first; present the change once with its shas oldest-first.
  const subject = [...cluster].sort((a, b) => b.subject.length - a.subject.length)[0].subject;
  const links = [...cluster]
    .reverse()
    .map((entry) => `[${entry.sha.slice(0, 10)}](${repo}/commit/${entry.sha.slice(0, 10)})`)
    .join(", ");
  return `- ${escapeMd(subject)} (${links})`;
}

export function renderCommitChangelogSection(
  probe: Probe,
  context: CollectedContext,
): {
  section: string;
  totalCommits: number;
  categoryCounts: Record<string, number>;
} {
  const repo = repoUrl();
  const buckets = new Map<string, CommitEntry[]>(CATEGORIES.map((c) => [c.title, []]));
  const otherCommits: CommitEntry[] = [];
  for (const commit of context.commits) {
    const subject = commit.subject ?? "";
    const cleaned = subject.replace(/^\S+\s+/, "");
    const entry: CommitEntry = {
      sha: commit.sha,
      subject: cleaned,
      scope: /^\w+\(([^)]+)\)/.exec(cleaned)?.[1] ?? "",
      tokens: subjectTokens(cleaned),
    };
    const category = CATEGORIES.find((c) => c.match.test(subject));
    if (category) buckets.get(category.title)?.push(entry);
    else otherCommits.push(entry);
  }
  const renderedBuckets = new Map<string, string[]>();
  for (const [title, commits] of buckets) {
    renderedBuckets.set(
      title,
      clusterCommits(commits).map((cluster) => renderCluster(cluster, repo)),
    );
  }
  const other = clusterCommits(otherCommits).map((cluster) => renderCluster(cluster, repo));

  const stats = context.releaseStats ?? null;
  const compare = probe.previousTag ? `${repo}/compare/${probe.previousTag}...v${probe.version}` : repo;
  const statsLine = stats
    ? `${stats.totalCommits} commits since [${probe.previousTag ?? "the previous release"}](${compare}): ` +
      `${stats.filesChanged} files changed, +${stats.insertions} / -${stats.deletions} lines. `
    : "";

  const sections: string[] = [];
  for (const c of CATEGORIES) {
    const items = renderedBuckets.get(c.title) ?? [];
    const commitCount = buckets.get(c.title)?.length ?? 0;
    const label = commitCount === items.length ? `${items.length}` : `${items.length} changes, ${commitCount} commits`;
    if (items.length) sections.push(`### ${c.title} (${label})\n\n${items.join("\n")}`);
  }
  if (other.length) {
    const label =
      otherCommits.length === other.length
        ? `${other.length}`
        : `${other.length} changes, ${otherCommits.length} commits`;
    sections.push(`### Chores and maintenance (${label})\n\n${other.join("\n")}`);
  }

  const categoryCounts = Object.fromEntries([
    ...CATEGORIES.map((c) => [c.title, buckets.get(c.title)?.length ?? 0] as const),
    ["Other", otherCommits.length] as const,
  ]);

  const section = [
    `## ${probe.version} (${probe.releaseDate})`,
    "",
    `${statsLine}Release notes: [smithers.sh/changelogs/${probe.version}](https://smithers.sh/changelogs/${probe.version}).`,
    "",
    sections.join("\n\n"),
  ].join("\n");

  return { section, totalCommits: context.commits.length, categoryCounts };
}

const HEADER = `# smithers-orchestrator

This is the complete, commit-level changelog. For the guided tour of each
release (what changed and why it matters, with screenshots and examples), see
the release notes at [smithers.sh/changelogs](https://smithers.sh/changelogs).
`;

/**
 * Prepend (or idempotently replace) this release's section in the repo-root
 * CHANGELOG.md. With write=false the result goes to <artifactDir>/CHANGELOG.md
 * as a preview and the real file is untouched.
 */
export function upsertCommitChangelog(options: {
  probe: Probe;
  context: CollectedContext;
  write: boolean;
  artifactDir?: string;
}): { path: string; written: boolean; totalCommits: number; categories: Record<string, number> } {
  const { probe, context, write } = options;
  const { section, totalCommits, categoryCounts } = renderCommitChangelogSection(probe, context);
  const realPath = join(process.cwd(), "CHANGELOG.md");
  const existing = existsSync(realPath) ? readFileSync(realPath, "utf8") : `${HEADER}`;

  const versionHeading = `## ${probe.version} `;
  let next: string;
  if (existing.includes(versionHeading)) {
    // Replace the existing section for this version (regen is idempotent).
    const start = existing.indexOf(versionHeading);
    const rest = existing.slice(start + versionHeading.length);
    const nextHeading = rest.search(/\n## /);
    const end = nextHeading === -1 ? existing.length : start + versionHeading.length + nextHeading + 1;
    next = existing.slice(0, start) + section + "\n" + existing.slice(end);
  } else {
    const firstSection = existing.search(/\n## /);
    next =
      firstSection === -1
        ? `${existing.trimEnd()}\n\n${section}\n`
        : `${existing.slice(0, firstSection)}\n${section}\n${existing.slice(firstSection)}`;
  }

  const target = write
    ? realPath
    : join(process.cwd(), options.artifactDir ?? ".smithers/artifacts/release-content", probe.version, "CHANGELOG.md");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, next);
  return { path: target, written: write, totalCommits, categories: categoryCounts };
}

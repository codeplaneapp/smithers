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

export function renderCommitChangelogSection(probe: Probe, context: CollectedContext): {
  section: string;
  totalCommits: number;
  categoryCounts: Record<string, number>;
} {
  const repo = repoUrl();
  const buckets = new Map<string, string[]>(CATEGORIES.map((c) => [c.title, []]));
  const other: string[] = [];
  for (const commit of context.commits) {
    const subject = commit.subject ?? "";
    const cleaned = escapeMd(subject.replace(/^\S+\s+/, ""));
    const short = commit.sha.slice(0, 10);
    const entry = `- ${cleaned} ([${short}](${repo}/commit/${short}))`;
    const category = CATEGORIES.find((c) => c.match.test(subject));
    if (category) buckets.get(category.title)?.push(entry);
    else other.push(entry);
  }

  const stats = context.releaseStats ?? null;
  const compare = probe.previousTag ? `${repo}/compare/${probe.previousTag}...v${probe.version}` : repo;
  const statsLine = stats
    ? `${stats.totalCommits} commits since [${probe.previousTag ?? "the previous release"}](${compare}): ` +
      `${stats.filesChanged} files changed, +${stats.insertions} / -${stats.deletions} lines. `
    : "";

  const sections: string[] = [];
  for (const c of CATEGORIES) {
    const items = buckets.get(c.title) ?? [];
    if (items.length) sections.push(`### ${c.title} (${items.length})\n\n${items.join("\n")}`);
  }
  if (other.length) sections.push(`### Chores and maintenance (${other.length})\n\n${other.join("\n")}`);

  const categoryCounts = Object.fromEntries(
    [...CATEGORIES.map((c) => [c.title, buckets.get(c.title)?.length ?? 0] as const), ["Other", other.length] as const],
  );

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

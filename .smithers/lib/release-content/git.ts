import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CollectedContext, Probe, ReleaseContentInput } from "./schemas";

const MAX_EXCERPT_CHARS = 4000;

function run(command: string, args: string[], fallback = ""): string {
  try {
    return execFileSync(command, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return fallback;
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function incrementVersion(version: string, bump: "patch" | "minor" | "major"): string {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) {
    throw new Error(`Cannot parse version "${version}" - expected MAJOR.MINOR.PATCH`);
  }
  let [major, minor, patch] = parts as [number, number, number];
  if (bump === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bump === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function slugVersion(version: string): string {
  return version.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function tagExists(tag: string): boolean {
  return run("git", ["tag", "--list", tag])
    .split("\n")
    .map((line) => line.trim())
    .includes(tag);
}

/**
 * The "previous release" tag for a diff range: the highest `vMAJOR.MINOR.PATCH`
 * tag strictly below `nextVersion`. Deliberately NOT just the newest tag — once
 * `pnpm version` has created `v<nextVersion>` at HEAD, the newest tag IS the
 * release being prepared, so `<newest tag>..HEAD` is empty and the changelog
 * comes out blank ("claim-no-commits").
 */
function previousReleaseTag(nextVersion: string): string | null {
  return run("git", ["tag", "--list", "v*"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((tag) => ({ tag, version: tag.replace(/^v/, "") }))
    .filter((entry) => /^\d+\.\d+\.\d+$/.test(entry.version))
    .filter((entry) => compareVersions(entry.version, nextVersion) < 0)
    .sort((a, b) => compareVersions(b.version, a.version))[0]?.tag ?? null;
}

export function probeRelease(input: ReleaseContentInput): Probe {
  const root = process.cwd();
  const pkg = readJson<{ version: string }>(join(root, "package.json"));
  // If `v<pkg.version>` already exists, `pnpm version` ran before this workflow,
  // so pkg.version IS the release target — do not bump it again (bumping again
  // is what produced 0.25.1 instead of 0.25.0 in the 0.25.0 dry run). The tag
  // also exists when pkg.version is already *published*, though, and there the
  // next release DOES need a bump — so an explicit `version` or `bump` input
  // always wins over this inference.
  const alreadyBumped = !input.version && !input.bump && tagExists(`v${pkg.version}`);
  const bump = input.bump ?? (input.version || alreadyBumped ? null : "patch");
  const nextVersion =
    input.version ?? (alreadyBumped ? pkg.version : incrementVersion(pkg.version, bump ?? "patch"));
  const tag = previousReleaseTag(nextVersion);
  const range = input.range ?? (tag ? `${tag}..HEAD` : "HEAD");
  const currentSha = run("git", ["rev-parse", "HEAD"], "unknown");
  const releaseDate = input.releaseDate ?? todayIso();
  const changelogPath = input.output.changelogPath ?? `docs/changelogs/${nextVersion}.mdx`;
  const threadPath = input.output.threadPath ?? `marketing/${nextVersion}/thread.md`;
  const blogPath =
    input.output.blogPath ?? `marketing/${nextVersion}/blog-smithers-${slugVersion(nextVersion)}.mdx`;

  return {
    currentVersion: pkg.version,
    nextVersion,
    version: nextVersion,
    bump,
    range,
    previousTag: tag,
    currentSha,
    releaseDate,
    changelogPath,
    blogPath,
    threadPath,
    artifactRoot: input.output.artifactDir,
  };
}

function parseCommits(range: string): CollectedContext["commits"] {
  const raw = run("git", ["log", "--no-merges", "--format=%H%x1f%s%x1f%b%x1e", range]);
  if (!raw) return [];
  return raw
    .split("\x1e")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha = "", subject = "", body = ""] = chunk.split("\x1f");
      return { sha, subject, body };
    });
}

function readExcerpt(path: string): string | null {
  const abs = join(process.cwd(), path);
  if (!existsSync(abs)) return null;
  const stat = statSync(abs);
  if (!stat.isFile() || stat.size > 1_000_000) return null;
  const text = readFileSync(abs, "utf8");
  return text.length > MAX_EXCERPT_CHARS ? `${text.slice(0, MAX_EXCERPT_CHARS)}\n...` : text;
}

function isUsefulExcerptPath(path: string): boolean {
  if (path.endsWith(".png") || path.endsWith(".jpg") || path.endsWith(".gif")) return false;
  if (path.endsWith(".db") || path.endsWith(".sqlite")) return false;
  return (
    path === "package.json" ||
    path.startsWith("docs/changelogs/") ||
    path.startsWith("docs/") ||
    path.startsWith("packages/") ||
    path.startsWith("apps/cli/") ||
    path.startsWith(".smithers/workflows/") ||
    path.startsWith(".smithers/prompts/") ||
    path.startsWith("examples/")
  );
}

function latestVersionedFiles(dir: string, ext: string, limit: number): Array<{ version: string; path: string }> {
  const abs = join(process.cwd(), dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((name) => name.endsWith(ext))
    .map((name) => ({
      version: name.slice(0, -ext.length),
      path: join(dir, name),
    }))
    .sort((a, b) => compareVersions(a.version, b.version))
    .slice(-limit);
}

function latestMarketingThreads(limit: number): Array<{ version: string; path: string }> {
  const dir = join(process.cwd(), "marketing");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^\d+\.\d+/.test(name))
    .map((version) => ({ version, path: `marketing/${version}/thread.md` }))
    .filter((entry) => existsSync(join(process.cwd(), entry.path)))
    .sort((a, b) => compareVersions(a.version, b.version))
    .slice(-limit);
}

/**
 * Exact tag-to-tag stats for the release. These feed the narrative changelog
 * ("1,169 commits, 417 fixes") and the launch thread, so they must be computed
 * deterministically here, never estimated by an agent. The category counts key
 * off the emoji conventional-commit prefixes used across the repo.
 */
function computeReleaseStats(range: string, commits: CollectedContext["commits"]) {
  const shortstat = run("git", ["diff", "--shortstat", range]);
  const files = Number(/(\d+) files? changed/.exec(shortstat)?.[1] ?? 0);
  const insertions = Number(/(\d+) insertions?/.exec(shortstat)?.[1] ?? 0);
  const deletions = Number(/(\d+) deletions?/.exec(shortstat)?.[1] ?? 0);
  const count = (re: RegExp) => commits.filter((c) => re.test(c.subject)).length;
  return {
    totalCommits: commits.length,
    filesChanged: files,
    insertions,
    deletions,
    featCommits: count(/^✨/),
    fixCommits: count(/^(🐛|🔒)/),
    securityCommits: count(/^🔒/),
    perfCommits: count(/^(⚡️|⚡)/),
    refactorCommits: count(/^♻️/),
    testCommits: count(/^✅/),
    docsCommits: count(/^📝/),
  };
}

export function collectReleaseContext(input: ReleaseContentInput, probe: Probe): CollectedContext {
  const changedFiles = input.skip.collectGit
    ? []
    : run("git", ["diff", "--name-only", probe.range])
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
  const diffStats = input.skip.collectGit ? "" : run("git", ["diff", "--stat", probe.range]);
  const commits = input.skip.collectGit ? [] : parseCommits(probe.range);
  const releaseStats = input.skip.collectGit ? null : computeReleaseStats(probe.range, commits);

  const fileExcerpts = changedFiles
    .filter(isUsefulExcerptPath)
    .slice(0, 40)
    .map((path) => ({ path, excerpt: readExcerpt(path) }))
    .filter((entry): entry is { path: string; excerpt: string } => entry.excerpt !== null);

  const priorChangelogs = input.skip.collectDocs
    ? []
    : latestVersionedFiles("docs/changelogs", ".mdx", 5)
        .filter((entry) => entry.version !== probe.version)
        .map((entry) => ({ version: entry.version, excerpt: readExcerpt(entry.path) ?? "" }))
        .filter((entry) => entry.excerpt);

  const priorThreads = input.skip.collectDocs
    ? []
    : latestMarketingThreads(3)
        .filter((entry) => entry.version !== probe.version)
        .map((entry) => ({ version: entry.version, excerpt: readExcerpt(entry.path) ?? "" }))
        .filter((entry) => entry.excerpt);

  return {
    version: probe.version,
    range: probe.range,
    commits,
    changedFiles,
    diffStats,
    releaseStats,
    fileExcerpts,
    priorChangelogs,
    priorThreads,
    manualContext: input.releaseContext,
    notes:
      commits.length === 0 && changedFiles.length === 0
        ? "No git context was collected. Use manualHighlights/manualProof for a factual release brief."
        : "Git and local release context collected.",
  };
}

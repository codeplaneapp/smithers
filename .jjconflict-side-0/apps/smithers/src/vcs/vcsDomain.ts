export type VcsKind = "git" | "jj";

export type VcsChangeCategory =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "conflicted"
  | "untracked"
  | "unknown";

export type VcsChange = {
  path: string;
  oldPath?: string;
  status: string;
  category: VcsChangeCategory;
};

export type VcsRepoState = {
  kind: VcsKind;
  available: boolean;
  repoRoot: string | null;
  current: string | null;
  bookmarks: string[];
  changes: VcsChange[];
  clean: boolean;
  error: string | null;
};

export type VcsSnapshot = {
  workspacePath: string;
  repoRoot: string | null;
  primary: VcsKind | null;
  detected: {
    git: boolean;
    jj: boolean;
  };
  git: VcsRepoState | null;
  jj: VcsRepoState | null;
  generatedAtMs: number;
};

export type LocalRepoDetection = {
  workspacePath: string;
  repoRoot: string | null;
  primary: VcsKind | null;
  hasGit: boolean;
  hasJj: boolean;
};

export const unavailableGitState = (error: string): VcsRepoState => ({
  kind: "git",
  available: false,
  repoRoot: null,
  current: null,
  bookmarks: [],
  changes: [],
  clean: false,
  error,
});

export const unavailableJjState = (error: string): VcsRepoState => ({
  kind: "jj",
  available: false,
  repoRoot: null,
  current: null,
  bookmarks: [],
  changes: [],
  clean: false,
  error,
});

function gitCategory(code: string): VcsChangeCategory {
  if (code.includes("U") || code === "AA" || code === "DD") return "conflicted";
  if (code === "??") return "untracked";
  if (code.includes("R")) return "renamed";
  if (code.includes("C")) return "copied";
  if (code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  if (code.includes("M") || code.includes("T")) return "modified";
  return "unknown";
}

export function parseGitStatusPorcelain(output: string): Pick<VcsRepoState, "current" | "changes" | "clean"> {
  const changes: VcsChange[] = [];
  let current: string | null = null;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (line.startsWith("## ")) {
      const branch = line.slice(3);
      const noCommits = branch.match(/^No commits yet on (.+)$/);
      if (noCommits) {
        current = noCommits[1];
        continue;
      }
      if (branch.startsWith("HEAD ")) {
        current = "detached";
        continue;
      }
      current = branch.split("...")[0]?.split(" [")[0]?.trim() || null;
      continue;
    }

    const status = line.slice(0, 2);
    const rest = line.slice(3);
    const rename = rest.match(/^(.*) -> (.*)$/);
    changes.push({
      status,
      category: gitCategory(status),
      path: rename ? rename[2] : rest,
      ...(rename ? { oldPath: rename[1] } : {}),
    });
  }

  return { current, changes, clean: changes.length === 0 };
}

export function parseGitBranches(output: string): string[] {
  const branches = output
    .split(/\r?\n/)
    .map((line) => line.replace(/^\*\s*/, "").trim())
    .filter(Boolean);
  return [...new Set(branches)].sort((left, right) => left.localeCompare(right));
}

function jjCategory(value: string): VcsChangeCategory {
  const normalized = value.trim().toLowerCase();
  if (normalized === "a") return "added";
  if (normalized === "m") return "modified";
  if (normalized === "d") return "deleted";
  if (normalized === "r") return "renamed";
  if (normalized === "c") return "conflicted";
  if (normalized === "?") return "untracked";
  if (normalized.startsWith("added ")) return "added";
  if (normalized.startsWith("modified ")) return "modified";
  if (normalized.startsWith("deleted ")) return "deleted";
  if (normalized.startsWith("renamed ")) return "renamed";
  if (normalized.startsWith("copied ")) return "copied";
  if (normalized.startsWith("conflict")) return "conflicted";
  if (normalized.startsWith("untracked ")) return "untracked";
  return "unknown";
}

function unquoteJjPath(path: string): string {
  const trimmed = path.trim();
  const quoted = trimmed.match(/^"(.+)"$/);
  return quoted ? quoted[1] : trimmed;
}

function jjPath(line: string): string {
  const withoutKind = line
    .replace(/^(Added|Modified|Deleted|Renamed|Copied|Untracked|Conflicted?|Conflict)\s+/i, "")
    .replace(/^regular file\s+/i, "")
    .replace(/^file\s+/i, "")
    .trim();
  return unquoteJjPath(withoutKind);
}

function parseCompactJjChange(line: string): VcsChange | null {
  const match = line.match(/^([MADRC?])\s+(.+)$/);
  if (!match) return null;
  const status = match[1];
  const rest = match[2].trim();
  const rename = rest.match(/^(.*?)\s+(?:=>|->)\s+(.*)$/);
  return {
    status,
    category: jjCategory(status),
    path: unquoteJjPath(rename ? rename[2] : rest),
    ...(rename ? { oldPath: unquoteJjPath(rename[1]) } : {}),
  };
}

export function parseJjStatus(output: string): Pick<VcsRepoState, "current" | "changes" | "clean"> {
  const changes: VcsChange[] = [];
  let current: string | null = null;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const workingCopy = line.match(/^Working copy(?:\s+\(([^)]+)\))?\s*:\s*([^\s]+)?/i);
    if (workingCopy) {
      current = workingCopy[1] ?? workingCopy[2] ?? null;
      continue;
    }
    const compactChange = parseCompactJjChange(line);
    if (compactChange) {
      changes.push(compactChange);
      continue;
    }
    if (/^(Added|Modified|Deleted|Renamed|Copied|Untracked|Conflicted?|Conflict)\s+/i.test(line)) {
      changes.push({
        status: line.split(/\s+/)[0] ?? "Unknown",
        category: jjCategory(line),
        path: jjPath(line),
      });
    }
  }

  return { current, changes, clean: changes.length === 0 };
}

export function parseJjBookmarks(output: string): string[] {
  const bookmarks = output
    .split(/\r?\n/)
    .filter((line) => line.trim() === line)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("Hint:"))
    .map((line) => {
      const withoutState = line.replace(/\s+\((?:conflicted|deleted)\):?.*$/i, "");
      return withoutState.split(":")[0]?.replace(/\*$/, "").trim();
    })
    .filter((value): value is string => Boolean(value));
  return [...new Set(bookmarks)].sort((left, right) => left.localeCompare(right));
}

export function buildSnapshot(args: {
  detection: LocalRepoDetection;
  git: VcsRepoState | null;
  jj: VcsRepoState | null;
  generatedAtMs?: number;
}): VcsSnapshot {
  return {
    workspacePath: args.detection.workspacePath,
    repoRoot: args.detection.repoRoot,
    primary: args.detection.primary,
    detected: { git: args.detection.hasGit, jj: args.detection.hasJj },
    git: args.git,
    jj: args.jj,
    generatedAtMs: args.generatedAtMs ?? Date.now(),
  };
}

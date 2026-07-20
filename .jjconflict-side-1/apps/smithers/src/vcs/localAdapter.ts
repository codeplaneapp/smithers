import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  buildSnapshot,
  parseGitBranches,
  parseGitStatusPorcelain,
  parseJjBookmarks,
  parseJjStatus,
  unavailableGitState,
  unavailableJjState,
  type LocalRepoDetection,
  type VcsKind,
  type VcsRepoState,
  type VcsSnapshot,
} from "./vcsDomain";

const execFileAsync = promisify(execFile);

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string },
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: CommandRunner = async (command, args, options) => {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
};

function parentDir(path: string): string | null {
  const parent = dirname(path);
  return parent === path ? null : parent;
}

export function detectLocalRepo(startPath: string): LocalRepoDetection {
  const workspacePath = resolve(startPath);
  let cursor: string | null = workspacePath;
  let gitRoot: string | null = null;
  let jjRoot: string | null = null;

  while (cursor) {
    if (!jjRoot && existsSync(resolve(cursor, ".jj"))) jjRoot = cursor;
    if (!gitRoot && existsSync(resolve(cursor, ".git"))) gitRoot = cursor;
    if (jjRoot && gitRoot) break;
    cursor = parentDir(cursor);
  }

  const primary: VcsKind | null = jjRoot ? "jj" : gitRoot ? "git" : null;
  return {
    workspacePath,
    repoRoot: jjRoot ?? gitRoot,
    primary,
    hasGit: gitRoot !== null,
    hasJj: jjRoot !== null,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function readGitState(repoRoot: string, runner: CommandRunner): Promise<VcsRepoState> {
  try {
    const [status, branches] = await Promise.all([
      runner("git", ["status", "--porcelain=v1", "--branch"], { cwd: repoRoot }),
      runner("git", ["branch", "--format=%(refname:short)"], { cwd: repoRoot }),
    ]);
    const parsed = parseGitStatusPorcelain(status.stdout);
    return {
      kind: "git",
      available: true,
      repoRoot,
      current: parsed.current,
      bookmarks: parseGitBranches(branches.stdout),
      changes: parsed.changes,
      clean: parsed.clean,
      error: null,
    };
  } catch (error) {
    return unavailableGitState(errorMessage(error));
  }
}

async function readJjState(repoRoot: string, runner: CommandRunner): Promise<VcsRepoState> {
  try {
    const [root, status, bookmarks] = await Promise.all([
      runner("jj", ["--no-pager", "root"], { cwd: repoRoot }),
      runner("jj", ["--no-pager", "--color=never", "status"], { cwd: repoRoot }),
      runner("jj", ["--no-pager", "--color=never", "bookmark", "list", "--template", 'name ++ "\\n"'], {
        cwd: repoRoot,
      }),
    ]);
    const parsed = parseJjStatus(status.stdout);
    return {
      kind: "jj",
      available: true,
      repoRoot: root.stdout.trim() || repoRoot,
      current: parsed.current,
      bookmarks: parseJjBookmarks(bookmarks.stdout),
      changes: parsed.changes,
      clean: parsed.clean,
      error: null,
    };
  } catch (error) {
    return unavailableJjState(errorMessage(error));
  }
}

export async function readLocalVcsSnapshot(
  workspacePath: string,
  runner: CommandRunner = defaultRunner,
): Promise<VcsSnapshot> {
  const detection = detectLocalRepo(workspacePath);
  if (!detection.repoRoot) {
    return buildSnapshot({ detection, git: null, jj: null });
  }

  const [git, jj] = await Promise.all([
    detection.hasGit ? readGitState(detection.repoRoot, runner) : Promise.resolve(null),
    detection.hasJj ? readJjState(detection.repoRoot, runner) : Promise.resolve(null),
  ]);

  return buildSnapshot({ detection, git, jj });
}

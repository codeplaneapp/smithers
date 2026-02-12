import { spawn } from "node:child_process";
/**
 * Cross-version-safe JJ helpers.
 *
 * - Every helper accepts an optional `cwd` so callers can target a repo path.
 * - Spawning errors (e.g. jj not installed) are normalized to `code: 127`
 *   instead of throwing, giving stable error shapes for callers and tests.
 * - Workspace operations try multiple syntaxes to tolerate JJ version drift.
 */

export type RunJjOptions = {
  cwd?: string;
};

export type RunJjResult = {
  code: number;
  stdout: string;
  stderr: string;
};

/**
 * Run a `jj` command and capture output.
 * Minimal helper used by vcs features and safe to call when jj is missing.
 */
export async function runJj(
  args: string[],
  opts: RunJjOptions = {},
): Promise<RunJjResult> {
  return await new Promise<RunJjResult>((resolve) => {
    try {
      const child = spawn("jj", args, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: opts.cwd,
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => (stdout += chunk.toString("utf8")));
      child.stderr?.on("data", (chunk) => (stderr += chunk.toString("utf8")));
      child.on("error", (err) => {
        // When jj isn't installed or cannot spawn, normalize to code 127
        resolve({
          code: 127,
          stdout: "",
          stderr: err.message || "spawn error",
        });
      });
      child.on("close", (code, signal) => {
        const withSignal = signal ? `terminated by signal ${signal}` : stderr;
        resolve({ code: code ?? 1, stdout, stderr: withSignal });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({ code: 127, stdout: "", stderr: message });
    }
  });
}

function jjError(res: RunJjResult): string {
  return res.stderr.trim() || `jj exited with code ${res.code}`;
}

/**
 * Returns the current workspace change id (jj `change_id`) or null on failure.
 * Accepts optional `cwd` to run inside a target repository.
 */
export async function getJjPointer(cwd?: string): Promise<string | null> {
  const res = await runJj(
    ["log", "-r", "@", "--no-graph", "--template", "change_id"],
    { cwd },
  );
  if (res.code === 0) {
    const out = res.stdout.trim();
    return out ? out : null;
  }
  return null;
}

export type JjRevertResult = {
  success: boolean;
  error?: string;
};

/**
 * Restore the working copy to a previously recorded jujutsu `change_id`.
 * Kept for backwards compatibility with existing tests.
 */
export async function revertToJjPointer(
  pointer: string,
  cwd?: string,
): Promise<JjRevertResult> {
  const res = await runJj(["restore", "--from", pointer], { cwd });
  if (res.code === 0) return { success: true };
  return { success: false, error: jjError(res) };
}

/**
 * Quick repo detection by executing a read-only jj command.
 */
export async function isJjRepo(cwd?: string): Promise<boolean> {
  // `jj log -r @` is stable across JJ versions; success implies in-repo
  const res = await runJj(["log", "-r", "@", "-n", "1", "--no-graph"], { cwd });
  return res.code === 0;
}

export type WorkspaceAddOptions = {
  cwd?: string;
  atRev?: string; // optional revision/op to base the workspace from
};

export type WorkspaceResult = {
  success: boolean;
  error?: string;
};

/**
 * Create a new JJ workspace at `path` with a friendly `name`.
 * NOTE: Syntax may vary between JJ versions; this helper aims to be permissive.
 */
export async function workspaceAdd(
  name: string,
  path: string,
  opts: WorkspaceAddOptions = {},
): Promise<WorkspaceResult> {
  // Construct multiple attempts to handle JJ syntax differences across versions.
  const attempts: string[][] = [];
  const revTail = opts.atRev ? ["-r", opts.atRev] : [];

  // Primary: current JJ syntax – destination path as positional, name via --name
  attempts.push(["workspace", "add", path, "--name", name, ...revTail]);

  // Alt 1: put -r before path/name
  if (opts.atRev)
    attempts.push(["workspace", "add", "-r", opts.atRev, path, "--name", name]);

  // Alt 2: legacy style (name, path)
  attempts.push(["workspace", "add", name, path, ...revTail]);

  // Alt 3: explicit --wc-path form seen in some versions
  attempts.push(["workspace", "add", "--wc-path", path, name, ...revTail]);

  let lastErr = "";
  for (const args of attempts) {
    const res = await runJj(args, { cwd: opts.cwd });
    if (res.code === 0) return { success: true };
    lastErr = jjError(res);
  }
  return { success: false, error: lastErr };
}

export type WorkspaceInfo = {
  name: string;
  path: string | null;
  selected: boolean;
};

/**
 * List existing workspaces, parsing human output heuristically.
 */
export async function workspaceList(cwd?: string): Promise<WorkspaceInfo[]> {
  // Prefer structured output to avoid version-specific human formats
  const res = await runJj(["workspace", "list", "-T", 'name ++ "\\n"'], {
    cwd,
  });
  if (res.code !== 0) return [];
  const lines = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.map((name) => ({ name, path: null, selected: false }));
}

/**
 * Close the given workspace by name.
 */
export async function workspaceClose(
  name: string,
  opts: { cwd?: string } = {},
): Promise<WorkspaceResult> {
  // `jj workspace close` does not exist; correct subcommand is `forget`.
  const res = await runJj(["workspace", "forget", name], { cwd: opts.cwd });
  if (res.code === 0) return { success: true };
  return { success: false, error: jjError(res) };
}

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REVIEW_PROCESS_ENV_KEYS = [
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TZ",
  "TERM",
  "NO_COLOR",
  "CI",
  "GITHUB_ACTIONS",
  "RUNNER_OS",
  "RUNNER_ARCH",
  "RUNNER_TEMP",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "WINDIR",
  "PATHEXT",
  "COMSPEC",
] as const;

const LINUX_TOOLS = {
  sudo: "/usr/bin/sudo",
  unshare: "/usr/bin/unshare",
  setpriv: "/usr/bin/setpriv",
  env: "/usr/bin/env",
  useradd: "/usr/sbin/useradd",
  userdel: "/usr/sbin/userdel",
  groupdel: "/usr/sbin/groupdel",
  id: "/usr/bin/id",
  pgrep: "/usr/bin/pgrep",
  chown: "/usr/bin/chown",
  chmod: "/usr/bin/chmod",
} as const;

export function buildReviewProcessEnvironment(input: {
  baseEnv: NodeJS.ProcessEnv;
  isolatedHome: string;
  explicit: Record<string, string>;
}): Record<string, string> {
  const forbiddenExplicit = new Set([
    "HOME",
    "USER",
    "LOGNAME",
    "RUNNER_TEMP",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SMITHERS_HOME",
    "SMITHERS_REVIEW_DISABLE_REGISTERED_ACCOUNTS",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "CODEX_AUTH_JSON",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ]);
  for (const key of Object.keys(input.explicit)) {
    if (forbiddenExplicit.has(key)) throw new Error(`review process explicit environment cannot set ${key}`);
  }
  const env: Record<string, string> = {};
  for (const key of REVIEW_PROCESS_ENV_KEYS) {
    const value = input.baseEnv[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  env.HOME = input.isolatedHome;
  env.SMITHERS_HOME = join(input.isolatedHome, ".smithers");
  const isolatedTemp = join(input.isolatedHome, "tmp");
  env.RUNNER_TEMP = isolatedTemp;
  env.TMPDIR = isolatedTemp;
  env.TMP = isolatedTemp;
  env.TEMP = isolatedTemp;
  env.SMITHERS_REVIEW_DISABLE_REGISTERED_ACCOUNTS = "1";
  Object.assign(env, input.explicit);
  return env;
}

export function buildReviewSpawnCommand(input: {
  bunPath: string;
  args: string[];
  env: Record<string, string>;
  sandboxIdentity?: ReviewSandboxIdentity;
}): { command: string; args: string[]; env: Record<string, string> } {
  if (!input.sandboxIdentity) return { command: input.bunPath, args: input.args, env: input.env };
  const childEnv = {
    ...input.env,
    USER: input.sandboxIdentity.user,
    LOGNAME: input.sandboxIdentity.user,
  };
  const assignments = Object.entries(childEnv).map(([key, value]) => `${key}=${value}`);
  const sudoEnv: Record<string, string> = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TZ", "TERM"]) {
    const value = process.env[key];
    if (value) sudoEnv[key] = value;
  }
  return {
    command: LINUX_TOOLS.sudo,
    // The review command is PID 1 in a fresh PID namespace. Linux kills every
    // descendant when that namespace's init exits, so a daemonized child
    // cannot outlive the workflow-command fence or race trusted output reads.
    args: [
      "-n", "--",
      LINUX_TOOLS.unshare, "--pid", "--fork", "--kill-child=SIGKILL", "--mount-proc",
      LINUX_TOOLS.setpriv,
      `--reuid=${input.sandboxIdentity.uid}`,
      `--regid=${input.sandboxIdentity.gid}`,
      "--clear-groups", "--no-new-privs", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all",
      "--", LINUX_TOOLS.env, "-i", ...assignments, input.bunPath, ...input.args,
    ],
    env: sudoEnv,
  };
}

export function workflowCommandFence(token = crypto.randomUUID().replace(/-/g, "")): {
  stop: string;
  resume: string;
} {
  if (!/^[A-Za-z0-9_]+$/.test(token)) throw new Error("workflow command fence token is invalid");
  return {
    stop: `::stop-commands::${token}\n`,
    resume: `::${token}::\n`,
  };
}

export interface ReviewSandboxIdentity {
  user: string;
  uid: string;
  gid: string;
}

function removeIsolatedUser(user: string): void {
  try { execFileSync(LINUX_TOOLS.sudo, ["-n", LINUX_TOOLS.userdel, user], { stdio: "ignore" }); } catch { /* best effort during failed setup */ }
  try { execFileSync(LINUX_TOOLS.sudo, ["-n", LINUX_TOOLS.groupdel, user], { stdio: "ignore" }); } catch { /* userdel often removes its private group */ }
}

function prepareIsolatedUser(outputDir: string): ReviewSandboxIdentity | undefined {
  // Protected replay inputs are meaningful only when the reviewer has a
  // distinct UID.  Production must never silently fall back to the runner's
  // identity; portable unit tests inject their explicit runtime boundary.
  if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true") {
    throw new Error("review sandbox requires a Linux Actions runner with a distinct unprivileged UID");
  }
  if (readFileSync("/proc/sys/fs/protected_hardlinks", "utf8").trim() !== "1") {
    throw new Error("review sandbox requires Linux protected_hardlinks=1");
  }
  const user = `smithers-r-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  try {
    execFileSync(LINUX_TOOLS.sudo, [
      "-n", LINUX_TOOLS.useradd, "--system", "--user-group", "--no-create-home", "--shell", "/usr/sbin/nologin", user,
    ], { stdio: "ignore" });
    // Fail closed if the runner cannot establish the distinct UID or make the
    // dedicated output directory writable by it.
    const uid = execFileSync(LINUX_TOOLS.id, ["-u", user], { encoding: "utf8" }).trim();
    const gid = execFileSync(LINUX_TOOLS.id, ["-g", user], { encoding: "utf8" }).trim();
    const groups = execFileSync(LINUX_TOOLS.id, ["-G", user], { encoding: "utf8" }).trim().split(/\s+/);
    if (
      !/^\d+$/.test(uid) || !/^\d+$/.test(gid)
      || uid === "0" || uid === String(process.getuid?.())
      || groups.length !== 1 || groups[0] !== gid || groups.includes("0")
    ) {
      throw new Error("review sandbox did not resolve to a distinct unprivileged UID");
    }
    execFileSync(LINUX_TOOLS.sudo, ["-n", LINUX_TOOLS.chown, "-R", "--no-dereference", `${uid}:${gid}`, outputDir], { stdio: "ignore" });
    execFileSync(LINUX_TOOLS.sudo, ["-n", LINUX_TOOLS.chmod, "0700", outputDir], { stdio: "ignore" });
    return { user, uid, gid };
  } catch (error) {
    removeIsolatedUser(user);
    throw error;
  }
}

function cleanupIsolatedUser(outputDir: string, identity: ReviewSandboxIdentity): void {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error("runner UID/GID is unavailable");
  let cleanupError: unknown;
  try {
    // `unshare` should already have reaped the namespace. Verify that invariant
    // before trusted code reads or takes ownership of child-controlled files.
    try {
      execFileSync(LINUX_TOOLS.pgrep, ["-u", identity.uid], { stdio: "ignore" });
      throw new Error("review sandbox still has live processes after namespace exit");
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 1) throw error;
    }
    execFileSync(LINUX_TOOLS.sudo, ["-n", LINUX_TOOLS.chown, "-R", "--no-dereference", `${uid}:${gid}`, outputDir], { stdio: "ignore" });
  } catch (error) {
    cleanupError = error;
  }
  try {
    execFileSync(LINUX_TOOLS.sudo, ["-n", LINUX_TOOLS.userdel, identity.user], { stdio: "ignore" });
  } catch (error) {
    cleanupError ??= error;
  }
  try {
    execFileSync(LINUX_TOOLS.sudo, ["-n", LINUX_TOOLS.groupdel, identity.user], { stdio: "ignore" });
  } catch (error) {
    // userdel often removes the matching private group first.
    if ((error as { status?: number }).status !== 6) cleanupError ??= error;
  }
  if (cleanupError) throw cleanupError;
}

export interface RunReviewRuntime {
  prepareIsolatedUser(outputDir: string): ReviewSandboxIdentity | undefined;
  cleanupIsolatedUser(outputDir: string, identity: ReviewSandboxIdentity): void;
}

const productionRuntime: RunReviewRuntime = {
  prepareIsolatedUser,
  cleanupIsolatedUser,
};

/**
 * Spawn the smithers review CLI against a workspace checkout with proxy-mode
 * env (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`). Walkthrough publishing is
 * deliberately performed by the parent only after every agent exits, so the
 * publish credential never exists in an agent ancestor's environment.
 *
 * Stdio is inherited so the user sees the CLI's progress in their job log. The
 * promise resolves with the exit code; the caller decides whether to fail the
 * action.
 */
export interface RunReviewInput {
  smithersRoot: string;
  workspace: string;
  prNumber: number;
  /** Loopback-broker ANTHROPIC_* overrides for the hosted review process. */
  inferenceEnv: Record<string, string>;
  actionPath: string;
  ghFixturePath: string;
  capturePath: string;
  outputDir: string;
  /** Reviewer comprehension quiz mode; omitted = the CLI's default. */
  quiz?: "off" | "auto" | "on";
  bunPath?: string;
  /** When set, the CLI writes a machine-readable outcome JSON here. */
  summaryPath?: string;
  immutableManifestPath?: string;
}

export async function runReview(
  input: RunReviewInput,
  runtime: RunReviewRuntime = productionRuntime,
): Promise<number> {
  const cliPath = join(input.smithersRoot, "apps", "review", "src", "cli", "main.ts");
  const args = [
    cliPath,
    input.workspace,
    "--pr",
    String(input.prNumber),
    "--out",
    join(input.outputDir, "walkthrough.html"),
    "--db",
    join(input.outputDir, "review.db"),
    // The hosted analyze job has a 30-minute wall clock. Four bounded waves of
    // file reviews leave time for install, verification, narration, and upload.
    "--concurrency",
    "16",
    "--timeout",
    "5",
  ];
  if (input.quiz) args.push("--quiz", input.quiz);

  return new Promise<number>((resolve, reject) => {
    // cwd must be the smithers checkout, never the workspace: bun reads
    // bunfig.toml from its cwd, and a workspace bunfig (preload) would make
    // bun auto-install workspace deps that are not installed there. The
    // workspace is passed as the CLI's positional repo argument instead.
    const isolatedHome = join(input.outputDir, "home");
    mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
    mkdirSync(join(isolatedHome, "tmp"), { recursive: true, mode: 0o700 });
    const env = buildReviewProcessEnvironment({
      baseEnv: process.env,
      isolatedHome,
      explicit: {
        ...input.inferenceEnv,
        // The target checkout is intentionally owned by the Actions runner,
        // while the reviewer runs as a separate unprivileged UID. Mark only
        // that exact checkout safe so Git remains usable without weakening
        // ownership checks globally.
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: input.workspace,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        SMITHERS_GH_BIN: join(input.actionPath, "src", "replayGh.ts"),
        SMITHERS_REVIEW_GH_FIXTURE: input.ghFixturePath,
        SMITHERS_REVIEW_CAPTURE_PATH: input.capturePath,
        // A pull request must not hide its own files through head-controlled
        // .gitignore or .opencodereview/rule.json policy.
        SMITHERS_REVIEW_TRUSTED_POLICY_ONLY: "1",
        ...(input.summaryPath ? { SMITHERS_REVIEW_SUMMARY_PATH: input.summaryPath } : {}),
        ...(input.immutableManifestPath ? { SMITHERS_REVIEW_IMMUTABLE_MANIFEST: input.immutableManifestPath } : {}),
        ...(process.env.SMITHERS_REVIEW_EXPECTED_BASE_SHA ? { SMITHERS_REVIEW_EXPECTED_BASE_SHA: process.env.SMITHERS_REVIEW_EXPECTED_BASE_SHA } : {}),
      },
    });
    const sandboxIdentity = runtime.prepareIsolatedUser(input.outputDir);
    const invocation = buildReviewSpawnCommand({
      bunPath: input.bunPath ?? "bun",
      args,
      env,
      sandboxIdentity,
    });
    let resumeCommands = () => {};
    if (process.env.GITHUB_ACTIONS === "true") {
      const fence = workflowCommandFence();
      process.stdout.write(fence.stop);
      let resumed = false;
      resumeCommands = () => {
        if (resumed) return;
        resumed = true;
        process.stdout.write(fence.resume);
      };
    }
    let child;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: input.smithersRoot,
        stdio: "inherit",
        env: invocation.env,
      });
    } catch (error) {
      try {
        if (sandboxIdentity) runtime.cleanupIsolatedUser(input.outputDir, sandboxIdentity);
      } catch {
        // Preserve the synchronous spawn failure, which is the primary cause.
      }
      resumeCommands();
      reject(error);
      return;
    }
    let settled = false;
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      try {
        if (sandboxIdentity) runtime.cleanupIsolatedUser(input.outputDir, sandboxIdentity);
      } catch {
        // Preserve the spawn failure, which is the primary cause.
      }
      resumeCommands();
      reject(error);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      try {
        if (sandboxIdentity) runtime.cleanupIsolatedUser(input.outputDir, sandboxIdentity);
        resumeCommands();
        resolve(code ?? 1);
      } catch (error) {
        resumeCommands();
        reject(error);
      }
    });
  });
}

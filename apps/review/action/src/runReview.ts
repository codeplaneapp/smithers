import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
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

export function buildReviewProcessEnvironment(input: {
  baseEnv: NodeJS.ProcessEnv;
  isolatedHome: string;
  explicit: Record<string, string>;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of REVIEW_PROCESS_ENV_KEYS) {
    const value = input.baseEnv[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  env.HOME = input.isolatedHome;
  env.SMITHERS_HOME = join(input.isolatedHome, ".smithers");
  env.SMITHERS_REVIEW_DISABLE_REGISTERED_ACCOUNTS = "1";
  Object.assign(env, input.explicit);
  return env;
}

export function buildReviewSpawnCommand(input: {
  bunPath: string;
  args: string[];
  env: Record<string, string>;
  sandboxUser?: string;
}): { command: string; args: string[]; env: Record<string, string> } {
  if (!input.sandboxUser) return { command: input.bunPath, args: input.args, env: input.env };
  const assignments = Object.entries(input.env).map(([key, value]) => `${key}=${value}`);
  const sudoEnv: Record<string, string> = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TZ", "TERM"]) {
    const value = process.env[key];
    if (value) sudoEnv[key] = value;
  }
  return {
    command: "sudo",
    args: ["-n", "-u", input.sandboxUser, "--", "env", "-i", ...assignments, input.bunPath, ...input.args],
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

function prepareIsolatedUser(outputDir: string): string | undefined {
  if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true") return undefined;
  const user = "smithers-review-sandbox";
  try {
    execFileSync("id", ["-u", user], { stdio: "ignore" });
  } catch {
    execFileSync("sudo", [
      "-n", "useradd", "--system", "--no-create-home", "--shell", "/usr/sbin/nologin", user,
    ], { stdio: "ignore" });
  }
  // Fail closed if the runner cannot establish the distinct UID or make the
  // dedicated output directory writable by it.
  const uid = execFileSync("id", ["-u", user], { encoding: "utf8" }).trim();
  const gid = execFileSync("id", ["-g", user], { encoding: "utf8" }).trim();
  const groups = execFileSync("id", ["-G", user], { encoding: "utf8" }).trim().split(/\s+/);
  if (
    !/^\d+$/.test(uid) || !/^\d+$/.test(gid)
    || uid === "0" || uid === String(process.getuid?.())
    || groups.length !== 1 || groups[0] !== gid || groups.includes("0")
  ) {
    throw new Error("review sandbox did not resolve to a distinct unprivileged UID");
  }
  execFileSync("sudo", ["-n", "chown", "-R", `${uid}:${gid}`, outputDir], { stdio: "ignore" });
  execFileSync("sudo", ["-n", "chmod", "0700", outputDir], { stdio: "ignore" });
  return user;
}

function restoreOutputOwnership(outputDir: string): void {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error("runner UID/GID is unavailable");
  execFileSync("sudo", ["-n", "chown", "-R", `${uid}:${gid}`, outputDir], { stdio: "ignore" });
}

export interface RunReviewRuntime {
  prepareIsolatedUser(outputDir: string): string | undefined;
  restoreOutputOwnership(outputDir: string): void;
}

const productionRuntime: RunReviewRuntime = {
  prepareIsolatedUser,
  restoreOutputOwnership,
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
  ];
  if (input.quiz) args.push("--quiz", input.quiz);

  return new Promise<number>((resolve, reject) => {
    // cwd must be the smithers checkout, never the workspace: bun reads
    // bunfig.toml from its cwd, and a workspace bunfig (preload) would make
    // bun auto-install workspace deps that are not installed there. The
    // workspace is passed as the CLI's positional repo argument instead.
    const isolatedHome = join(input.outputDir, "home");
    mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
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
        SMITHERS_GH_BIN: join(input.actionPath, "src", "replayGh.ts"),
        SMITHERS_REVIEW_GH_FIXTURE: input.ghFixturePath,
        SMITHERS_REVIEW_CAPTURE_PATH: input.capturePath,
        // A pull request must not hide its own files through head-controlled
        // .gitignore or .opencodereview/rule.json policy.
        SMITHERS_REVIEW_TRUSTED_POLICY_ONLY: "1",
        ...(input.summaryPath ? { SMITHERS_REVIEW_SUMMARY_PATH: input.summaryPath } : {}),
      },
    });
    const sandboxUser = runtime.prepareIsolatedUser(input.outputDir);
    const invocation = buildReviewSpawnCommand({
      bunPath: input.bunPath ?? "bun",
      args,
      env,
      sandboxUser,
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
      resumeCommands();
      reject(error);
      return;
    }
    let settled = false;
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      resumeCommands();
      try {
        if (sandboxUser) runtime.restoreOutputOwnership(input.outputDir);
      } catch {
        // Preserve the spawn failure, which is the primary cause.
      }
      reject(error);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      resumeCommands();
      try {
        if (sandboxUser) runtime.restoreOutputOwnership(input.outputDir);
        resolve(code ?? 1);
      } catch (error) {
        reject(error);
      }
    });
  });
}

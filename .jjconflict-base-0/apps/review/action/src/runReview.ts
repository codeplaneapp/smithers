import { spawn } from "node:child_process";
import { join } from "node:path";

/**
 * Spawn the smithers review CLI against a workspace checkout with proxy-mode
 * env (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`) and the matching publish
 * config so the walkthrough is uploaded through the same session.
 *
 * Stdio is inherited so the user sees the CLI's progress in their job log. The
 * promise resolves with the exit code; the caller decides whether to fail the
 * action.
 */
export interface RunReviewInput {
  smithersRoot: string;
  workspace: string;
  prNumber: number;
  /** ANTHROPIC_* overrides for proxy mode; empty for subscription mode. */
  inferenceEnv: Record<string, string>;
  publishUrl: string;
  publishToken: string;
  ghToken?: string;
  /** Reviewer comprehension quiz mode; omitted = the CLI's default. */
  quiz?: "off" | "auto" | "on";
  bunPath?: string;
  /** When set, the CLI writes a machine-readable outcome JSON here. */
  summaryPath?: string;
}

export async function runReview(input: RunReviewInput): Promise<number> {
  const cliPath = join(input.smithersRoot, "apps", "review", "src", "cli", "main.ts");
  const args = [cliPath, input.workspace, "--pr", String(input.prNumber), "--publish"];
  if (input.quiz) args.push("--quiz", input.quiz);

  return new Promise<number>((resolve, reject) => {
    // cwd must be the smithers checkout, never the workspace: bun reads
    // bunfig.toml from its cwd, and a workspace bunfig (preload) would make
    // bun auto-install workspace deps that are not installed there. The
    // workspace is passed as the CLI's positional repo argument instead.
    const child = spawn(input.bunPath ?? "bun", args, {
      cwd: input.smithersRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        ...input.inferenceEnv,
        SMITHERS_REVIEW_PUBLISH_URL: input.publishUrl,
        SMITHERS_REVIEW_PUBLISH_TOKEN: input.publishToken,
        GH_TOKEN: input.ghToken ?? process.env.GH_TOKEN ?? "",
        ...(input.summaryPath ? { SMITHERS_REVIEW_SUMMARY_PATH: input.summaryPath } : {}),
      },
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

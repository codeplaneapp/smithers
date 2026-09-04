import { spawn } from "node:child_process";
import { z } from "zod/v4";

export type Receipt = {
  sha: string;
  repo: string;
  tier: "fast" | "thorough";
  verdict: "passed" | "failed";
  durationMs: number;
  ranAtIso: string;
};

// Fixture stub: the origin file imports `writeReceipt` from
// `../../../scripts/ci-receipt`, which lives outside the copied pack.
async function writeReceipt(receipt: {
  repo: string;
  tier: "fast" | "thorough";
  verdict: "passed" | "failed";
  durationMs: number;
  sha?: string;
}): Promise<Receipt> {
  return { ...receipt, sha: receipt.sha ?? "unknown", ranAtIso: new Date().toISOString() };
}

export const commandRunSchema = z.object({
  name: z.string(),
  command: z.string(),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  stdoutTail: z.string().default(""),
  stderrTail: z.string().default(""),
});

export const pipelineCheckSchema = z.object({
  verdict: z.enum(["passed", "failed"]),
  durationMs: z.number().int().nonnegative(),
  commands: z.array(commandRunSchema).default([]),
  failedCommand: z.string().nullable().default(null),
  summary: z.string().default(""),
});

export const receiptSchema = z.object({
  sha: z.string(),
  repo: z.string(),
  tier: z.enum(["fast", "thorough"]),
  verdict: z.enum(["passed", "failed"]),
  durationMs: z.number().int().nonnegative(),
  ranAtIso: z.string(),
});

export type PipelineCheck = z.infer<typeof pipelineCheckSchema>;

function tailText(value: string, max = 12_000): string {
  return value.length > max ? value.slice(value.length - max) : value;
}

function printableCommand(command: string[]): string {
  return command.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ");
}

export async function runCommand(
  name: string,
  command: string[],
  options: { timeoutMs?: number; env?: Record<string, string | undefined> } = {},
): Promise<z.infer<typeof commandRunSchema>> {
  const startedAt = Date.now();
  let stdout = "";
  let stderr = "";

  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), {
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, options.timeoutMs ?? 30 * 60_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = tailText(stdout + chunk.toString("utf8"), 160_000);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = tailText(stderr + chunk.toString("utf8"), 160_000);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        name,
        command: printableCommand(command),
        exitCode: 127,
        durationMs: Date.now() - startedAt,
        stdoutTail: "",
        stderrTail: error.message,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({
        name,
        command: printableCommand(command),
        exitCode: code ?? (signal ? 124 : 1),
        durationMs: Date.now() - startedAt,
        stdoutTail: tailText(stdout),
        stderrTail: tailText(stderr),
      });
    });
  });
}

export async function runPipelineSteps(
  steps: Array<{ name: string; command: string[]; timeoutMs?: number }>,
): Promise<PipelineCheck> {
  const startedAt = Date.now();
  const commands = [];
  let failedCommand: string | null = null;
  for (const step of steps) {
    const result = await runCommand(step.name, step.command, { timeoutMs: step.timeoutMs });
    commands.push(result);
    if (result.exitCode !== 0) {
      failedCommand = step.name;
      break;
    }
  }
  return {
    verdict: failedCommand ? "failed" : "passed",
    durationMs: Date.now() - startedAt,
    commands,
    failedCommand,
    summary: failedCommand ? `${failedCommand} failed` : "all commands passed",
  };
}

export async function recordPipelineReceipt(
  tier: "fast" | "thorough",
  verdict: "passed" | "failed",
  durationMs: number,
  sha?: string,
): Promise<Receipt> {
  return writeReceipt({ repo: "plue", tier, verdict, durationMs, sha });
}

export function failIfRed(check: PipelineCheck, label: string): void {
  if (check.verdict === "failed") {
    const failed = check.commands.find((command) => command.name === check.failedCommand);
    throw new Error(`${label} failed at ${check.failedCommand ?? "unknown"}: ${failed?.stderrTail || failed?.stdoutTail || "no output"}`);
  }
}

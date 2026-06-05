import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { config } from "./config.js";

/**
 * Run the patch-generation workflow for one instance via the local Smithers CLI
 * (`smithers up`), which executes the durable engine end to end. The workflow's
 * agents (`claude` / `codex`) run as subprocesses scoped to the checkout, so
 * each instance gets its own SQLite run DB and event log.
 *
 * @param {import("./loadInstances.js").SwebpInstance} instance
 * @param {string} repoDir
 * @param {object} [opts]
 * @param {string} [opts.implementerModel]
 * @param {string} [opts.reviewerModel]
 * @param {number} [opts.timeoutMs]
 * @param {boolean} [opts.echo]              Mirror child output to this process.
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ code: number, runId: string, logPath: string, timedOut: boolean }>}
 */
export function runWorkflowForInstance(instance, repoDir, opts = {}) {
  const log = opts.log ?? (() => {});
  const runId = `swebp-${instance.instanceId}`.replace(/[^A-Za-z0-9_.-]/g, "-");
  const runDir = join(config.workDir, "runs", instance.instanceId);
  // Each benchmark attempt is a fresh durable run against a fresh checkout —
  // clear any prior run DB/logs so the fixed run id does not collide (RUN_EXISTS).
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const logPath = join(runDir, "up.log");
  const dbPath = join(runDir, "smithers.db");

  const input = JSON.stringify({
    instanceId: instance.instanceId,
    repoDir,
    repo: instance.repo,
    repoLanguage: instance.repoLanguage,
    problemStatement: instance.problemStatement,
    requirements: instance.requirements,
    interface: instance.interface,
  });

  const env = {
    ...process.env,
    SWEBP_DB_PATH: dbPath,
    SWEBP_IMPLEMENTER_MODEL: opts.implementerModel ?? process.env.SWEBP_IMPLEMENTER_MODEL ?? "claude-opus-4-8",
    SWEBP_REVIEWER_MODEL: opts.reviewerModel ?? process.env.SWEBP_REVIEWER_MODEL ?? "gpt-5.5",
  };

  const args = [
    "run",
    config.cliEntry,
    "up",
    config.workflowPath,
    "--input",
    input,
    "--run-id",
    runId,
    "--max-concurrency",
    "1",
    "--allow-network",
    "--log-dir",
    runDir,
  ];

  log(`[run] ${instance.instanceId}: smithers up (run ${runId})…`);
  return new Promise((resolve) => {
    const out = createWriteStream(logPath);
    const child = spawn("bun", args, { cwd: config.repoRoot, env });
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;

    const pipe = (stream) => {
      stream.on("data", (chunk) => {
        out.write(chunk);
        if (opts.echo) process.stdout.write(chunk);
      });
    };
    pipe(child.stdout);
    pipe(child.stderr);

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      out.end();
      resolve({ code: code ?? -1, runId, logPath, timedOut });
    });
  });
}

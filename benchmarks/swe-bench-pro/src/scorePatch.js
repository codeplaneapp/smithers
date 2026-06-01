import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "./config.js";
import { createEntryScript, stripBinaryHunks } from "./createEntryScript.js";

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeoutMs ?? 0, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

/**
 * Ensure the per-instance image is present locally (explicit pull so progress is
 * visible and the platform is pinned). Safe to call repeatedly.
 *
 * @param {string} image
 * @returns {Promise<boolean>}
 */
export async function ensureImage(image) {
  const present = await run("docker", ["image", "inspect", image]);
  if (present.code === 0) return true;
  const pulled = await run("docker", ["pull", "--platform", config.dockerPlatform, image], {
    timeoutMs: 30 * 60 * 1000,
  });
  return pulled.code === 0;
}

/**
 * Score a single candidate patch against an instance's canonical Docker image.
 *
 * This reproduces the canonical evaluator (`swe_bench_pro_eval.py`) step for
 * step: it assembles the same four workspace files (patch.diff, run_script.sh,
 * parser.py, entryscript.sh), runs the entry script inside the prebuilt image,
 * and computes `resolved = (fail_to_pass ∪ pass_to_pass) ⊆ passed`.
 *
 * No part of the scoring trusts the agent: the run script and parser come from
 * ScaleAI's harness, the tests are checked out of the fix commit *inside* the
 * container, and a passing verdict requires every required test to report PASSED.
 *
 * @param {import("./loadInstances.js").SwebpInstance} instance
 * @param {string} patch                       Candidate diff (agent/gold/empty).
 * @param {object} [opts]
 * @param {string} [opts.prefix]               Label for artifacts (e.g. "model").
 * @param {boolean} [opts.blockNetwork]        Run tests with `--network none`.
 * @param {number} [opts.timeoutMs]            Hard cap for the container run.
 * @returns {Promise<{
 *   resolved: boolean,
 *   passed: string[],
 *   required: string[],
 *   missing: string[],
 *   tests: Array<{ name: string, status: string }>,
 *   containerExit: number,
 *   workspaceDir: string,
 * }>}
 */
export async function scorePatch(instance, patch, opts = {}) {
  const prefix = opts.prefix ?? "model";
  const workspaceDir = join(config.workDir, "score", instance.instanceId, prefix);
  rmSync(workspaceDir, { recursive: true, force: true });
  mkdirSync(workspaceDir, { recursive: true });

  const scriptsDir = join(config.harnessDir, "run_scripts", instance.instanceId);
  const runScript = readFileSync(join(scriptsDir, "run_script.sh"), "utf8");
  const parserScript = readFileSync(join(scriptsDir, "parser.py"), "utf8");

  writeFileSync(join(workspaceDir, "patch.diff"), stripBinaryHunks(patch ?? ""));
  writeFileSync(join(workspaceDir, "run_script.sh"), runScript);
  writeFileSync(join(workspaceDir, "parser.py"), parserScript);
  writeFileSync(join(workspaceDir, "entryscript.sh"), createEntryScript(instance));

  const args = [
    "run",
    "--rm",
    "--platform",
    config.dockerPlatform,
    "-v",
    `${workspaceDir}:/workspace`,
    "--entrypoint",
    "/bin/bash",
  ];
  if (opts.blockNetwork) args.push("--network", "none");
  args.push(instance.dockerImage, "-c", "bash /workspace/entryscript.sh");

  const result = await run("docker", args, { timeoutMs: opts.timeoutMs ?? 60 * 60 * 1000 });

  /** @type {Array<{ name: string, status: string }>} */
  let tests = [];
  try {
    tests = JSON.parse(readFileSync(join(workspaceDir, "output.json"), "utf8")).tests ?? [];
  } catch {
    tests = [];
  }

  const passed = new Set(tests.filter((t) => t.status === "PASSED").map((t) => t.name));
  const required = [...new Set([...instance.failToPass, ...instance.passToPass])];
  const missing = required.filter((name) => !passed.has(name));

  // Canonical criterion (swe_bench_pro_eval.py:558): (f2p ∪ p2p) ⊆ passed.
  // For a non-degenerate instance (required.length > 0) this equals
  // missing.length === 0. The degenerate empty-required case (0/731 in the
  // public split) is vacuously "resolved" here exactly as the canonical set
  // subset is, and is then caught by the gold/empty integrity gate and the
  // empty-required exclusion in runInstance — so it is never a free pass.
  return {
    resolved: missing.length === 0,
    passed: [...passed],
    required,
    missing,
    tests,
    containerExit: result.code,
    workspaceDir,
  };
}

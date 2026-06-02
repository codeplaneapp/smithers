/**
 * Node-side bridge between the SWE-EVO smithers workflow and the hermetic
 * Docker harness. These run as plain compute tasks (no LLM), so they are
 * deterministic and fully observable in the run timeline.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = join(HERE, "..", "harness");
const PLATFORM = process.env.SWEEVO_PLATFORM ?? "linux/amd64";

export type Instance = Record<string, unknown> & {
  instance_id: string;
  repo: string;
  base_commit: string;
  image: string;
  problem_statement: string;
  test_patch: string;
  test_cmds: string;
  log_parser: string;
  FAIL_TO_PASS: string[];
  PASS_TO_PASS: string[];
};

function sh(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): string {
  return execFileSync(cmd, args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? 600_000,
    maxBuffer: 256 * 1024 * 1024,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Working directory for an instance's repo checkout (shared across its tasks). */
export function workdirFor(instanceId: string): string {
  const root = process.env.SWEEVO_WORKROOT ?? join(tmpdir(), "sweevo-work");
  return join(root, instanceId.replace(/[^A-Za-z0-9._-]/g, "_"));
}

/**
 * Materialize the instance repo at base_commit on the host by copying /testbed
 * out of the prebuilt image. The agents then edit this real checkout.
 */
export function prepareRepo(instance: Instance): {
  workdir: string;
  baseCommit: string;
  headLine: string;
} {
  const workdir = workdirFor(instance.instance_id);
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });

  const cid = sh("docker", ["create", "--platform", PLATFORM, instance.image]).trim();
  try {
    sh("docker", ["cp", `${cid}:/testbed/.`, workdir], { timeoutMs: 600_000 });
  } finally {
    try {
      sh("docker", ["rm", "-f", cid]);
    } catch {
      /* best effort */
    }
  }

  sh("git", ["config", "--global", "--add", "safe.directory", workdir]);
  // Pin to the exact base commit and discard anything not committed there.
  sh("git", ["-C", workdir, "checkout", "-f", instance.base_commit]);
  sh("git", ["-C", workdir, "clean", "-fdq"]);
  const headLine = sh("git", ["-C", workdir, "log", "--oneline", "-1"]).trim();
  return { workdir, baseCommit: instance.base_commit, headLine };
}

/**
 * Capture the agents' edits as a unified diff (including new files), the way the
 * scorer will apply it. Test-file edits are intentionally NOT stripped here —
 * the scorer reverts test files before applying the official test_patch, so they
 * cannot affect the result regardless.
 */
export function captureDiff(instance: Instance): {
  patch: string;
  changedFiles: number;
  insertions: number;
  deletions: number;
} {
  const workdir = workdirFor(instance.instance_id);
  sh("git", ["-C", workdir, "add", "-A"]);
  const patch = sh("git", ["-C", workdir, "diff", "--cached", "--no-color"], {
    timeoutMs: 120_000,
  });
  let stat = "";
  try {
    stat = sh("git", ["-C", workdir, "diff", "--cached", "--shortstat"]).trim();
  } catch {
    /* ignore */
  }
  const files = /(\d+) files? changed/.exec(stat)?.[1];
  const ins = /(\d+) insertions?/.exec(stat)?.[1];
  const del = /(\d+) deletions?/.exec(stat)?.[1];
  return {
    patch,
    changedFiles: files ? Number(files) : 0,
    insertions: ins ? Number(ins) : 0,
    deletions: del ? Number(del) : 0,
  };
}

export type ScoreResult = {
  instance_id: string;
  repo: string;
  image: string;
  log_parser: string;
  test_cmds: string;
  resolved: number;
  fix_rate: number;
  f2p_total: number;
  f2p_passed: number;
  p2p_total: number;
  p2p_passed: number;
  all_p2p_pass: boolean;
  candidate_applied: boolean;
  testpatch_applied: boolean;
  timed_out: boolean;
  duration_s: number;
  f2p_status: Record<string, string>;
  p2p_failures: Record<string, string>;
  parsed_test_count: number;
};

/**
 * Score a candidate patch in the instance's real Docker image using the vendored
 * SWE-bench/SWE-EVO parsers. This is the authoritative, non-fudgeable metric.
 */
export function scoreCandidate(instance: Instance, patch: string, timeoutS = 1800): ScoreResult {
  const dir = mkdtempSync(join(tmpdir(), "sweevo-score-"));
  const instPath = join(dir, "instance.json");
  const patchPath = join(dir, "candidate.patch");
  const outPath = join(dir, "result.json");
  writeFileSync(instPath, JSON.stringify(instance));
  writeFileSync(patchPath, patch ?? "");
  sh(
    "python3",
    [
      join(HARNESS, "score_instance.py"),
      "--instance",
      instPath,
      "--patch",
      patchPath,
      "--out",
      outPath,
      "--timeout",
      String(timeoutS),
      "--platform",
      PLATFORM,
    ],
    { cwd: HARNESS, timeoutMs: (timeoutS + 120) * 1000 },
  );
  const raw = execFileSync("cat", [outPath], { encoding: "utf8" });
  return JSON.parse(raw) as ScoreResult;
}

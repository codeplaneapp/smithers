import {
  applyDiffBundle,
  computeDiffBundle,
  computeDiffBundleBetweenRefs,
} from "@smithers-orchestrator/engine/effect/diff-bundle";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { resolveCommitPointer } from "./getNodeDiff.js";

const RUN_ID_MAX_LENGTH = 256;
export const RUN_DIFF_MAX_BYTES = 50 * 1024 * 1024;
const TERMINAL_RUN_STATUSES = new Set(["finished", "failed", "cancelled", "canceled", "continued"]);

class GetRunDiffError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GetRunDiffError";
    this.code = code;
  }
}

function validateRunId(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > RUN_ID_MAX_LENGTH) {
    throw new GetRunDiffError(
      "InvalidRequest",
      `runId must be a non-empty string of at most ${RUN_ID_MAX_LENGTH} characters.`,
    );
  }
  return value;
}

function terminalAttemptsByCwd(attempts) {
  const latest = new Map();
  for (const row of attempts) {
    if (!TERMINAL_RUN_STATUSES.has(row?.state) || typeof row.jjPointer !== "string" || !row.jjPointer) continue;
    const cwd = typeof row.jjCwd === "string" && row.jjCwd ? row.jjCwd : "";
    const previous = latest.get(cwd);
    const finished = Number(row.finishedAtMs ?? -1);
    const previousFinished = Number(previous?.finishedAtMs ?? -1);
    // Attempt number is only a tie breaker. A retry can finish before an
    // earlier attempt that was still in flight.
    if (
      !previous ||
      finished > previousFinished ||
      (finished === previousFinished && Number(row.attempt ?? 0) > Number(previous.attempt ?? 0))
    )
      latest.set(cwd, row);
  }
  return [...latest.values()];
}

function mergeBundles(bundles, baseRef) {
  const patches = [];
  const latestByPath = new Map();
  for (const bundle of bundles)
    for (const patch of Array.isArray(bundle?.patches) ? bundle.patches : []) {
      // Cached rows are ordered terminal deltas. Keeping the last operation
      // for a path avoids returning an obsolete first patch (modify/revert and
      // add/delete are common in retries). Exact composition is supplied by
      // the VCS path; this is only the durable cache fallback.
      latestByPath.set(patch.path, patch);
    }
  patches.push(...latestByPath.values());
  return {
    seq: Math.max(0, ...bundles.map((bundle) => Number(bundle?.seq ?? 0))),
    baseRef,
    patches,
  };
}

async function readCachedRunBundles(adapter, runId, baseRef) {
  if (typeof adapter.listNodeDiffCache !== "function") return null;
  const rows = await adapter.listNodeDiffCache(runId);
  const bundles = [];
  for (const row of [...(rows ?? [])].sort((a, b) => Number(a?.computedAtMs ?? 0) - Number(b?.computedAtMs ?? 0))) {
    if (typeof row?.diffJson !== "string") continue;
    try {
      const parsed = JSON.parse(row.diffJson);
      if (parsed && Array.isArray(parsed.patches)) bundles.push(parsed);
    } catch {
      // A corrupt cache row is not evidence of a clean run.
    }
  }
  return bundles;
}

function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

/** Compose sequential cached deltas in a disposable checkout, then re-diff
 * the resulting terminal tree from the immutable run base. */
async function cachedRunBundle(adapter, runId, baseRef, vcsRoot) {
  const bundles = await readCachedRunBundles(adapter, runId, baseRef);
  if (!bundles || bundles.length === 0 || !vcsRoot) return null;
  const checkout = await mkdtemp(join(tmpdir(), "smithers-run-diff-"));
  try {
    const clone = await runGit(checkout, ["clone", "--shared", vcsRoot, "."]);
    if (clone.code !== 0) return null;
    const checkedOut = await runGit(checkout, ["checkout", "--detach", baseRef]);
    if (checkedOut.code !== 0) return null;
    for (const bundle of bundles) await applyDiffBundle(bundle, checkout);
    return await computeDiffBundle(
      baseRef,
      checkout,
      Math.max(0, ...bundles.map((bundle) => Number(bundle?.seq ?? 0))),
    );
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
}

function finalizeRunBundle(bundle, baseRef, terminalRef) {
  const sizeBytes = Buffer.byteLength(JSON.stringify(bundle), "utf8");
  if (sizeBytes <= RUN_DIFF_MAX_BYTES) return { ok: true, payload: bundle };
  return {
    ok: true,
    payload: {
      status: "oversized",
      baseRef: bundle.baseRef ?? baseRef,
      terminalRef: terminalRef ?? "multiple",
      sizeBytes,
      maxBytes: RUN_DIFF_MAX_BYTES,
    },
  };
}

/**
 * Compute the final run diff directly between the run base and terminal VCS
 * revisions. Each checkout lane is reduced to its terminal tree; cached node
 * bundles are used only when the terminal checkout has been reaped.
 */
export async function getRunDiffRoute({
  runId: rawRunId,
  resolveRun,
  computeDiffBundleBetweenRefsImpl = computeDiffBundleBetweenRefs,
  resolveCommitPointerImpl = resolveCommitPointer,
}) {
  try {
    const runId = validateRunId(rawRunId);
    const resolved = await resolveRun(runId);
    if (!resolved)
      return {
        ok: false,
        error: { code: "RunNotFound", message: `Run not found: ${runId}` },
      };
    const run = await resolved.adapter.getRun(runId);
    if (!run)
      return {
        ok: false,
        error: { code: "RunNotFound", message: `Run not found: ${runId}` },
      };
    const baseRef = typeof run.vcsRevision === "string" ? run.vcsRevision : "";
    if (!baseRef)
      return {
        ok: false,
        error: {
          code: "VcsError",
          message: "Run has no immutable VCS base revision.",
        },
      };
    if (!TERMINAL_RUN_STATUSES.has(run.status)) {
      return {
        ok: false,
        error: {
          code: "VcsError",
          message: "Run diff is unavailable until the run reaches a terminal state.",
        },
      };
    }
    const attempts = await resolved.adapter.listAttemptsForRun(runId);
    const terminalAttempts = terminalAttemptsByCwd(attempts);
    if (terminalAttempts.length === 0) {
      if (attempts.length === 0) return { ok: true, payload: { seq: 0, baseRef, patches: [] } };
      const cached = await cachedRunBundle(resolved.adapter, runId, baseRef, run.vcsRoot);
      if (cached) return finalizeRunBundle(cached, baseRef, "multiple");
      const hasEvidence = attempts.some((row) => TERMINAL_RUN_STATUSES.has(row?.state));
      if (hasEvidence)
        return {
          ok: false,
          error: {
            code: "VcsError",
            message: "Run has no durable terminal VCS evidence.",
          },
        };
      return {
        ok: false,
        error: {
          code: "VcsError",
          message: "Run has no durable terminal VCS evidence.",
        },
      };
    }
    const bundles = [];
    for (const attempt of terminalAttempts) {
      // Reaped task worktrees are not durable. The run root is the surviving
      // VCS repository and is also sufficient for resolving immutable refs.
      const cwd = (typeof attempt.jjCwd === "string" && attempt.jjCwd) || run.vcsRoot;
      if (!cwd)
        return {
          ok: false,
          error: {
            code: "VcsError",
            message: "Run has no surviving VCS root for terminal diff resolution.",
          },
        };
      const resolveRef = run.vcsType === "jj" || !run.vcsType ? resolveCommitPointerImpl : async (ref) => ref;
      const terminalRef = await resolveRef(attempt.jjPointer, cwd);
      if (!terminalRef)
        return {
          ok: false,
          error: {
            code: "VcsError",
            message: `Unable to resolve terminal JJ revision for attempt ${attempt.attempt ?? "?"}.`,
          },
        };
      const resolvedBaseRef = await resolveRef(baseRef, cwd);
      if (!resolvedBaseRef)
        return {
          ok: false,
          error: {
            code: "VcsError",
            message: "Unable to resolve the run's base JJ revision.",
          },
        };
      try {
        bundles.push(
          await computeDiffBundleBetweenRefsImpl(resolvedBaseRef, terminalRef, cwd, Number(attempt.attempt ?? 0)),
        );
      } catch (error) {
        const cached = await cachedRunBundle(resolved.adapter, runId, baseRef, run.vcsRoot);
        if (cached) return finalizeRunBundle(cached, baseRef, "multiple");
        throw error;
      }
    }
    const bundle = bundles.length === 1 ? { ...bundles[0], baseRef } : mergeBundles(bundles, baseRef);
    return finalizeRunBundle(
      bundle,
      baseRef,
      terminalAttempts.length === 1 ? terminalAttempts[0].jjPointer : "multiple",
    );
  } catch (error) {
    if (error instanceof GetRunDiffError) return { ok: false, error: { code: error.code, message: error.message } };
    return {
      ok: false,
      error: {
        code: "Internal",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

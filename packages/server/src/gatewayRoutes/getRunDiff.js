import { computeDiffBundleBetweenRefs } from "@smithers-orchestrator/engine/effect/diff-bundle";
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
    throw new GetRunDiffError("InvalidRequest", `runId must be a non-empty string of at most ${RUN_ID_MAX_LENGTH} characters.`);
  }
  return value;
}

function terminalAttemptsByCwd(attempts) {
  const latest = new Map();
  for (const row of attempts) {
    if (row?.state !== "finished" || typeof row.jjPointer !== "string" || !row.jjPointer || typeof row.jjCwd !== "string" || !row.jjCwd) continue;
    const previous = latest.get(row.jjCwd);
    if (!previous || Number(row.finishedAtMs ?? -1) > Number(previous.finishedAtMs ?? -1) || Number(row.attempt ?? 0) > Number(previous.attempt ?? 0)) latest.set(row.jjCwd, row);
  }
  return [...latest.values()];
}

function mergeBundles(bundles, baseRef) {
  const patches = [];
  const seen = new Set();
  for (const bundle of bundles) for (const patch of Array.isArray(bundle?.patches) ? bundle.patches : []) {
    const key = `${patch.path}\0${patch.operation ?? "modify"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    patches.push(patch);
  }
  return { seq: Math.max(0, ...bundles.map((bundle) => Number(bundle?.seq ?? 0))), baseRef, patches };
}

async function cachedRunBundle(adapter, runId, baseRef) {
  if (typeof adapter.listNodeDiffCache !== "function") return null;
  const rows = await adapter.listNodeDiffCache(runId);
  const bundles = [];
  for (const row of rows ?? []) {
    if (typeof row?.diffJson !== "string") continue;
    try {
      const parsed = JSON.parse(row.diffJson);
      if (parsed && Array.isArray(parsed.patches)) bundles.push(parsed);
    } catch {
      // A corrupt cache row is not evidence of a clean run.
    }
  }
  return bundles.length > 0 ? mergeBundles(bundles, baseRef) : null;
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
    if (!resolved) return { ok: false, error: { code: "RunNotFound", message: `Run not found: ${runId}` } };
    const run = await resolved.adapter.getRun(runId);
    if (!run) return { ok: false, error: { code: "RunNotFound", message: `Run not found: ${runId}` } };
    if (run.vcsType && run.vcsType !== "jj") {
      return { ok: false, error: { code: "VcsError", message: `Unsupported VCS type: ${run.vcsType}. Only jj-backed runs are supported.` } };
    }
    const baseRef = typeof run.vcsRevision === "string" ? run.vcsRevision : "";
    if (!TERMINAL_RUN_STATUSES.has(run.status)) {
      return { ok: false, error: { code: "VcsError", message: "Run diff is unavailable until the run reaches a terminal state." } };
    }
    const attempts = await resolved.adapter.listAttemptsForRun(runId);
    const terminalAttempts = terminalAttemptsByCwd(attempts);
    const uncapturedFinished = attempts.some((row) => row?.state === "finished" && (typeof row.jjPointer !== "string" || !row.jjPointer || typeof row.jjCwd !== "string" || !row.jjCwd));
    if (uncapturedFinished) {
      const cached = await cachedRunBundle(resolved.adapter, runId, baseRef);
      if (cached) return { ok: true, payload: cached };
      return { ok: false, error: { code: "VcsError", message: "Run has finished attempts without durable VCS pointers." } };
    }
    if (terminalAttempts.length === 0) {
      if (attempts.length === 0) return { ok: true, payload: { seq: 0, baseRef, patches: [] } };
      const cached = await cachedRunBundle(resolved.adapter, runId, baseRef);
      if (cached) return { ok: true, payload: cached };
      const hasEvidence = attempts.some((row) => row?.state === "finished" || row?.state === "failed");
      if (hasEvidence) return { ok: true, payload: { seq: 0, baseRef, patches: [] } };
      return { ok: false, error: { code: "VcsError", message: "Run has no durable terminal VCS evidence." } };
    }
    const bundles = [];
    for (const attempt of terminalAttempts) {
      const cwd = attempt.jjCwd;
      const terminalRef = await resolveCommitPointerImpl(attempt.jjPointer, cwd);
      if (!terminalRef) return { ok: false, error: { code: "VcsError", message: `Unable to resolve terminal JJ revision for attempt ${attempt.attempt ?? "?"}.` } };
      const resolvedBaseRef = baseRef ? await resolveCommitPointerImpl(baseRef, cwd) : terminalRef;
      if (!resolvedBaseRef) return { ok: false, error: { code: "VcsError", message: "Unable to resolve the run's base JJ revision." } };
      try {
        bundles.push(await computeDiffBundleBetweenRefsImpl(resolvedBaseRef, terminalRef, cwd, Number(attempt.attempt ?? 0)));
      } catch (error) {
        const cached = await cachedRunBundle(resolved.adapter, runId, baseRef);
        if (cached) return { ok: true, payload: cached };
        throw error;
      }
    }
    const bundle = bundles.length === 1 ? bundles[0] : mergeBundles(bundles, baseRef);
    const sizeBytes = Buffer.byteLength(JSON.stringify(bundle), "utf8");
    if (sizeBytes > RUN_DIFF_MAX_BYTES) {
      return {
        ok: true,
        payload: {
          status: "oversized",
          baseRef: bundle.baseRef ?? baseRef,
          terminalRef: terminalAttempts.length === 1 ? await resolveCommitPointerImpl(terminalAttempts[0].jjPointer, terminalAttempts[0].jjCwd) : "multiple",
          sizeBytes,
          maxBytes: RUN_DIFF_MAX_BYTES,
        },
      };
    }
    return { ok: true, payload: bundle };
  } catch (error) {
    if (error instanceof GetRunDiffError) return { ok: false, error: { code: error.code, message: error.message } };
    return { ok: false, error: { code: "Internal", message: error instanceof Error ? error.message : String(error) } };
  }
}

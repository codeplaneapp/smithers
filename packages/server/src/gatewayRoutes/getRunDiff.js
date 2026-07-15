import { computeDiffBundleBetweenRefs } from "@smithers-orchestrator/engine/effect/diff-bundle";

const RUN_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;
export const RUN_DIFF_MAX_BYTES = 50 * 1024 * 1024;

class GetRunDiffError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GetRunDiffError";
    this.code = code;
  }
}

function validateRunId(value) {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) {
    throw new GetRunDiffError("InvalidRunId", "runId must match /^[a-z0-9_-]{1,64}$/.");
  }
  return value;
}

function latestFinishedAttempt(attempts) {
  return attempts
    .filter((row) => row?.state !== "in-progress" && typeof row?.jjPointer === "string" && row.jjPointer && typeof row?.jjCwd === "string" && row.jjCwd)
    .sort((a, b) => Number(b.finishedAtMs ?? -1) - Number(a.finishedAtMs ?? -1) || Number(b.attempt ?? 0) - Number(a.attempt ?? 0))[0] ?? null;
}

/**
 * Compute the final run diff directly between the run base and terminal VCS
 * revisions. This deliberately does not concatenate per-node patches: retries
 * and reverted work must be represented by the terminal tree.
 */
export async function getRunDiffRoute({
  runId: rawRunId,
  resolveRun,
  computeDiffBundleBetweenRefsImpl = computeDiffBundleBetweenRefs,
  resolveCommitPointerImpl = async (pointer) => pointer,
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
    const attempt = latestFinishedAttempt(await resolved.adapter.listAttemptsForRun(runId));
    if (!attempt) {
      return { ok: true, payload: { seq: 0, baseRef, patches: [] } };
    }
    const cwd = attempt.jjCwd;
    const terminalRef = await resolveCommitPointerImpl(attempt.jjPointer, cwd) ?? attempt.jjPointer;
    const resolvedBaseRef = baseRef ? await resolveCommitPointerImpl(baseRef, cwd) ?? baseRef : terminalRef;
    const bundle = await computeDiffBundleBetweenRefsImpl(resolvedBaseRef, terminalRef, cwd, Number(attempt.attempt ?? 0));
    const sizeBytes = Buffer.byteLength(JSON.stringify(bundle), "utf8");
    if (sizeBytes > RUN_DIFF_MAX_BYTES) {
      return {
        ok: true,
        payload: { status: "oversized", baseRef: resolvedBaseRef, terminalRef, sizeBytes, maxBytes: RUN_DIFF_MAX_BYTES },
      };
    }
    return { ok: true, payload: bundle };
  } catch (error) {
    if (error instanceof GetRunDiffError) return { ok: false, error: { code: error.code, message: error.message } };
    return { ok: false, error: { code: "VcsError", message: error instanceof Error ? error.message : String(error) } };
  }
}

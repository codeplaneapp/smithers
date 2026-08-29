import { parseJsonColumn } from "./parseJsonColumn";

// Structural subset of the engine's SmithersEvent (RunOptions.onProgress):
// NodeStarted/NodeFinished/NodeFailed carry { type, nodeId, timestampMs },
// NodeFailed adds { error }.
export type ProgressEvent = {
  type: string;
  nodeId?: string;
  timestampMs?: number;
  error?: unknown;
};

const REVIEW_FILE_ID = /^review-file-\d+-/;

const PHASE_LABELS: Record<string, { started: string; finished: string }> = {
  "collect-changes": { started: "collecting changed files…", finished: "changed files collected" },
  review: { started: "aggregating file reviews…", finished: "review aggregated" },
  "verify-findings": { started: "verify: adversarially checking findings…", finished: "verify: done" },
  "final-review": { started: "", finished: "final findings settled" },
  narrate: { started: "narrate: drafting the walkthrough story…", finished: "narrate: done" },
  quiz: { started: "quiz: writing reviewer comprehension questions…", finished: "quiz: done" },
  walkthrough: { started: "walkthrough: rendering HTML…", finished: "walkthrough: done" },
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error ?? "unknown error");
}

function seconds(startMs: number | undefined, endMs: number): string {
  if (startMs == null) return "";
  return ` (${Math.max(0, Math.round((endMs - startMs) / 1000))}s)`;
}

/**
 * Live stderr progress for a review run, fed by the engine's onProgress hook.
 * Per-file lines ("[3/12] src/foo.ts … 2 findings (48s)") as review tasks
 * finish, phase lines for verify/narrate/quiz/walkthrough, failures called
 * out. Row lookups (file path, findings count) go through the injected
 * loadRows so the reporter stays testable without a live engine; prints are
 * chained so async lookups never interleave lines.
 */
export function createProgressReporter(options: {
  loadRows: () => Promise<Record<string, ReadonlyArray<Record<string, unknown>>>>;
  write: (line: string) => void;
}): { onEvent: (event: ProgressEvent) => void; flush: () => Promise<void> } {
  const startedAt = new Map<string, number>();
  let finishedFiles = 0;
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (job: () => Promise<void>) => {
    chain = chain.then(job).catch(() => {});
  };

  const fileDetail = async (
    nodeId: string,
  ): Promise<{ path: string; findings: number | null; total: number | null }> => {
    const rows = await options.loadRows();
    let path = nodeId;
    let total: number | null = null;
    // loadOutputs returns json-mode columns as parsed arrays; raw sqlite rows and
    // the string test fixtures surface JSON strings — parseJsonColumn takes both.
    const files = parseJsonColumn<{ id?: string; path?: string }>(rows.reviewPrompt?.at(-1)?.files);
    if (files.length > 0) {
      total = files.length;
      const file = files.find((entry) => entry.id === nodeId);
      if (file?.path) path = file.path;
    }
    let findings: number | null = null;
    const row = (rows.agentReview ?? []).find((entry) => entry.nodeId === nodeId);
    if (row && row.comments != null && row.comments !== "") {
      findings = parseJsonColumn<unknown>(row.comments).length;
    }
    return { path, findings, total };
  };

  const onEvent = (event: ProgressEvent) => {
    const nodeId = event.nodeId;
    if (!nodeId) return;
    const at = event.timestampMs ?? Date.now();

    if (event.type === "NodeStarted") {
      startedAt.set(nodeId, at);
      const phase = PHASE_LABELS[nodeId];
      if (phase?.started) enqueue(async () => options.write(phase.started));
      return;
    }

    if (event.type === "NodeFinished") {
      const elapsed = seconds(startedAt.get(nodeId), at);
      if (REVIEW_FILE_ID.test(nodeId)) {
        finishedFiles += 1;
        const index = finishedFiles;
        enqueue(async () => {
          const detail = await fileDetail(nodeId);
          const counter = detail.total != null ? `[${index}/${detail.total}]` : `[${index}]`;
          const findings =
            detail.findings != null ? `${detail.findings} finding${detail.findings === 1 ? "" : "s"}` : "done";
          options.write(`${counter} ${detail.path} … ${findings}${elapsed}`);
        });
        return;
      }
      const phase = PHASE_LABELS[nodeId];
      if (phase?.finished) enqueue(async () => options.write(`${phase.finished}${elapsed}`));
      return;
    }

    if (event.type === "NodeFailed") {
      const elapsed = seconds(startedAt.get(nodeId), at);
      const message = errorMessage(event.error).split("\n")[0].slice(0, 200);
      if (REVIEW_FILE_ID.test(nodeId)) {
        finishedFiles += 1;
        const index = finishedFiles;
        enqueue(async () => {
          const detail = await fileDetail(nodeId);
          const counter = detail.total != null ? `[${index}/${detail.total}]` : `[${index}]`;
          options.write(`${counter} ${detail.path} … failed${elapsed}: ${message}`);
        });
        return;
      }
      enqueue(async () => options.write(`${nodeId} failed${elapsed}: ${message}`));
    }
  };

  return { onEvent, flush: () => chain };
}

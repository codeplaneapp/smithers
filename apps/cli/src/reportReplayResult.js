/**
 * Print the fork/time-travel replay outcome banner to stderr.
 *
 * @param {{
 *   result: { runId: string, vcsRestored?: boolean, vcsPointer?: string, vcsError?: string },
 *   parentRunId: string,
 *   parentFrame: number,
 *   stderr?: { write: (s: string) => void },
 * }} params
 */
export function reportReplayResult({ result, parentRunId, parentFrame, stderr = process.stderr }) {
  stderr.write(`[smithers] Forked run ${result.runId} from ${parentRunId}:${parentFrame}\n`);
  if (result.vcsRestored) {
    stderr.write(`[smithers] VCS state restored to ${result.vcsPointer}\n`);
  } else if (result.vcsError) {
    stderr.write(`[smithers] VCS state was not restored: ${result.vcsError}\n`);
  }
}

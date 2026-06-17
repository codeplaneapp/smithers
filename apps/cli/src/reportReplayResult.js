export function reportReplayResult({ result, parentRunId, parentFrame, stderr = process.stderr }) {
    stderr.write(`[smithers] Forked run ${result.runId} from ${parentRunId}:${parentFrame}\n`);
    if (result.vcsRestored) {
        stderr.write(`[smithers] VCS state restored to ${result.vcsPointer}\n`);
    }
    else if (result.vcsError) {
        stderr.write(`[smithers] VCS state was not restored: ${result.vcsError}\n`);
    }
}

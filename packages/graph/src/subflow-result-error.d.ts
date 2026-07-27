import { SmithersError } from '@smithers-orchestrator/errors/SmithersError';

/**
 * @param {string} nodeId
 * @param {{ runId: string; status: string; error?: unknown }} result
 * @returns {SmithersError}
 */
declare function createSubflowResultError(nodeId: string, result: {
    runId: string;
    status: string;
    error?: unknown;
}): SmithersError;

export { createSubflowResultError };

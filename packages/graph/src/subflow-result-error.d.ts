import { SmithersError } from '@smthrs/errors/SmithersError';

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

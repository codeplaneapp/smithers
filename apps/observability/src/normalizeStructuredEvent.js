import { normalizeStructuredEventForFamily } from "./_traceEventNormalizers.js";
/**
 * @typedef {import('./agentTrace.ts').AgentFamily} AgentFamily
 * @typedef {import('./_traceEventNormalizers.js').NormalizedTraceBatch} NormalizedTraceBatch
 */

/**
 * @param {AgentFamily} agentFamily
 * @param {any} parsed
 * @param {string} rawType
 * @returns {NormalizedTraceBatch}
 */
export function normalizeStructuredEvent(agentFamily, parsed, rawType) {
    return normalizeStructuredEventForFamily(agentFamily, parsed, rawType);
}

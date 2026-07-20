/**
 * @typedef {import('./agentTrace.ts').AgentFamily} AgentFamily
 */

/**
 * @param {any} agent
 * @returns {AgentFamily}
 */
export function detectAgentFamily(agent) {
    const constructorName = String(agent?.constructor?.name ?? "").toLowerCase();
    const idName = String(agent?.id ?? "").toLowerCase();
    const name = constructorName && constructorName !== "object"
        ? `${constructorName} ${idName}`
        : idName;
    if (name.includes("antigravity") || name.includes("agy")) return "antigravity";
    if (name.includes("codex")) return "codex";
    if (name.includes("claude")) return "claude-code";
    if (name.includes("gemini")) return "gemini";
    if (name.includes("kimi")) return "kimi";
    if (name.includes("openai")) return "openai";
    if (name.includes("anthropic")) return "anthropic";
    if (name.includes("amp")) return "amp";
    if (name.includes("forge")) return "forge";
    if (constructorName.includes("piagent") ||
        /(?:^|[-_\s])pi(?:$|[-_\s])/.test(idName)) {
        return "pi";
    }
    return "unknown";
}

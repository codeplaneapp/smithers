/** @typedef {import("./LlmJudgeConfig.js").LlmJudgeConfig} LlmJudgeConfig */
/** @typedef {import("./types.js").Scorer} Scorer */
/** @typedef {import("./types.js").ScorerInput} ScorerInput */
/** @typedef {import("./types.js").ScoreResult} ScoreResult */

/**
 * Extracts and parses a JSON object from a judge's free-form text response.
 *
 * First tries `JSON.parse` on the trimmed text. If that fails, scans for the
 * first `{` and walks forward tracking brace depth while respecting string
 * literals and escape sequences, so braces inside string values (e.g. a brace
 * in the `reason`) do not prematurely close the object.
 *
 * @param {string} text
 * @returns {Record<string, unknown> | undefined}
 */
function parseJudgeJson(text) {
    const trimmed = text.trim();
    try {
        return JSON.parse(trimmed);
    }
    catch {
        // fall through to balanced-brace extraction
    }
    const start = trimmed.indexOf("{");
    if (start === -1) {
        return undefined;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i++) {
        const char = trimmed[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === "\\") {
            if (inString) {
                escaped = true;
            }
            continue;
        }
        if (char === '"') {
            inString = !inString;
            continue;
        }
        if (inString) {
            continue;
        }
        if (char === "{") {
            depth++;
        }
        else if (char === "}") {
            depth--;
            if (depth === 0) {
                try {
                    return JSON.parse(trimmed.slice(start, i + 1));
                }
                catch {
                    return undefined;
                }
            }
        }
    }
    return undefined;
}

/**
 * Creates an LLM-as-judge scorer that delegates evaluation to an AI agent.
 *
 * The judge agent receives a prompt constructed from `promptTemplate` and is
 * expected to return a JSON object with `score` (0-1) and optional `reason`.
 *
 * ```ts
 * const toneScorer = llmJudge({
 *   id: "tone",
 *   name: "Professional Tone",
 *   description: "Evaluates professional tone",
 *   judge: new AnthropicAgent({ model: "claude-sonnet-4-20250514" }),
 *   instructions: "You evaluate text for professional tone.",
 *   promptTemplate: ({ output }) =>
 *     `Rate the professionalism of this text (0-1 JSON):\n\n${String(output)}`,
 * });
 * ```
 *
 * @param {LlmJudgeConfig} config
 * @returns {Scorer}
 */
export function llmJudge(config) {
    const { id, name, description, judge, instructions, promptTemplate } = config;
    /**
   * @param {ScorerInput} input
   * @returns {Promise<ScoreResult>}
   */
    const score = async (input) => {
        const prompt = promptTemplate(input);
        const response = await judge.generate({
            prompt: `${instructions}\n\n${prompt}`,
        });
        // The response can be a string, or an object with a text field
        const text = typeof response === "string"
            ? response
            : typeof response?.text === "string"
                ? response.text
                : JSON.stringify(response);
        // Try to parse JSON from the response. First attempt the whole trimmed
        // text, then fall back to the outermost balanced-brace object so that a
        // brace inside the judge's `reason` string does not truncate the match.
        const parsed = parseJudgeJson(text);
        if (parsed && typeof parsed === "object") {
            const rawScore = Number(parsed.score);
            return {
                score: Number.isFinite(rawScore)
                    ? Math.max(0, Math.min(1, rawScore))
                    : 0,
                reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
                meta: { raw: text },
            };
        }
        // If we can't parse JSON, return a low-confidence score
        return {
            score: 0,
            reason: "Failed to parse judge response as JSON",
            meta: { raw: text },
        };
    };
    return { id, name, description, score };
}

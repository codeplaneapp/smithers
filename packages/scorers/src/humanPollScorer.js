import { createScorer } from "./createScorer.js";
/** @typedef {import("./types.js").Scorer} Scorer */

/**
 * @param {unknown} candidate
 * @returns {{ question?: unknown; answer?: unknown }[] | null}
 */
function extractPoll(candidate) {
    if (Array.isArray(candidate))
        return candidate;
    if (typeof candidate === "object" && candidate !== null) {
        const poll = /** @type {{ poll?: unknown }} */ (candidate).poll;
        if (Array.isArray(poll))
            return poll;
    }
    return null;
}

/**
 * Normalizes one poll answer to [0, 1], or `null` when unrecognized.
 * Booleans map to 0/1; ratings (numbers or numeric strings) are clamped to
 * the 1-5 scale and mapped linearly (1 → 0, 5 → 1).
 *
 * @param {unknown} answer
 * @returns {number | null}
 */
function normalizeAnswer(answer) {
    if (typeof answer === "boolean")
        return answer ? 1 : 0;
    const rating = typeof answer === "number"
        ? answer
        : typeof answer === "string" && answer.trim() !== ""
            ? Number(answer)
            : Number.NaN;
    if (!Number.isFinite(rating))
        return null;
    const clamped = Math.max(1, Math.min(5, rating));
    return (clamped - 1) / 4;
}

/**
 * Creates the delegation-chain human-poll scorer.
 *
 * Consumes a submitted end-of-run user poll — an array of
 * `{ question, answer }` entries where answers are 1-5 ratings and/or
 * booleans — and normalizes it to a mean score in [0, 1]. The poll is read
 * from the scored `output` (preferred) or `context`, as either a bare array
 * or a `{ poll: [...] }` payload. With no poll (or no recognizable answers)
 * the scorer no-ops (score 1, `meta.skipped`).
 *
 * @returns {Scorer}
 */
export function humanPollScorer() {
    return createScorer({
        id: "human-poll",
        name: "Human Poll",
        description: "Normalizes a submitted end-of-run user poll (1-5 ratings and booleans) to a 0-1 score",
        score: async ({ output, context }) => {
            const poll = extractPoll(output) ?? extractPoll(context);
            if (!poll || poll.length === 0) {
                return {
                    score: 1,
                    reason: "No poll submitted; skipping",
                    meta: { skipped: true },
                };
            }
            /** @type {{ question: string; answer: unknown; normalized: number }[]} */
            const answers = [];
            /** @type {{ question: string; answer: unknown }[]} */
            const ignored = [];
            for (const entry of poll) {
                const question = typeof entry?.question === "string"
                    ? entry.question
                    : String(entry?.question ?? "");
                const normalized = normalizeAnswer(entry?.answer);
                if (normalized === null) {
                    ignored.push({ question, answer: entry?.answer });
                    continue;
                }
                answers.push({ question, answer: entry?.answer, normalized });
            }
            if (answers.length === 0) {
                return {
                    score: 1,
                    reason: "Poll contained no recognizable answers; skipping",
                    meta: { skipped: true, ignored },
                };
            }
            const score = answers.reduce((sum, a) => sum + a.normalized, 0) /
                answers.length;
            return {
                score: Math.max(0, Math.min(1, score)),
                reason: `${answers.length} poll answer(s), mean ${score.toFixed(2)}${ignored.length > 0 ? `; ${ignored.length} unrecognized answer(s) ignored` : ""}`,
                meta: { answers, ignored },
            };
        },
    });
}

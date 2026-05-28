import { describe, expect, test } from "bun:test";
import { llmJudge } from "../src/index.js";

/**
 * Builds a mock judge agent that always responds with the given text, so the
 * tests can exercise the response-parsing logic in isolation.
 *
 * @param {string} responseText
 */
function mockJudge(responseText) {
    return {
        generate: async () => ({ text: responseText }),
    };
}

/**
 * @param {string} responseText
 */
function makeScorer(responseText) {
    return llmJudge({
        id: "parse-test",
        name: "Parse Test",
        description: "Exercises judge response parsing",
        judge: mockJudge(responseText),
        instructions: "You are a judge.",
        promptTemplate: ({ output }) => `Rate: ${String(output)}`,
    });
}

const input = { input: "q", output: "a" };

describe("llmJudge response parsing (regression: brace in reason)", () => {
    test("KEY REGRESSION: a brace in the reason still yields the real score, not 0", async () => {
        // Pre-fix, the regex /\{[\s\S]*?"score"\s*:\s*[\d.]+[\s\S]*?\}/ stopped at
        // the first `}` (inside the reason), producing invalid JSON -> score 0.
        const scorer = makeScorer('{ "score": 0.8, "reason": "nested {obj} here" }');
        const result = await scorer.score(input);
        expect(result.score).toBe(0.8);
        expect(result.reason).toBe("nested {obj} here");
    });

    test("JSON wrapped in surrounding prose preserves the real score", async () => {
        const scorer = makeScorer(
            'Here is my evaluation:\n{"score": 0.7, "reason": "good answer"}\nThanks!',
        );
        const result = await scorer.score(input);
        expect(result.score).toBe(0.7);
        expect(result.reason).toBe("good answer");
    });

    test("nested objects in the JSON do not truncate the parse", async () => {
        const scorer = makeScorer(
            '{"score": 0.6, "reason": "ok", "details": {"a": 1, "b": {"c": 2}}}',
        );
        const result = await scorer.score(input);
        expect(result.score).toBe(0.6);
        expect(result.reason).toBe("ok");
    });

    test("escaped quotes inside the reason are preserved", async () => {
        const scorer = makeScorer(
            '{"score": 0.9, "reason": "the model said \\"hi {x}\\" exactly"}',
        );
        const result = await scorer.score(input);
        expect(result.score).toBe(0.9);
        expect(result.reason).toBe('the model said "hi {x}" exactly');
    });

    test("well-formed JSON with no braces in reason still works", async () => {
        const scorer = makeScorer('{"score": 1, "reason": "perfect"}');
        const result = await scorer.score(input);
        expect(result.score).toBe(1);
        expect(result.reason).toBe("perfect");
    });

    test("genuinely unparseable output falls back to score 0", async () => {
        const scorer = makeScorer("I cannot produce JSON for this, sorry.");
        const result = await scorer.score(input);
        expect(result.score).toBe(0);
        expect(result.reason).toBe("Failed to parse judge response as JSON");
    });
});

import { describe, expect, test } from "bun:test";
import { rctfCompletenessScorer } from "./rctfCompletenessScorer";

/**
 * Coverage for the RCTF completeness scorer added in commit a3a08ed38. It is
 * a thin wrapper around `llmJudge` that asks a judge agent to return JSON
 * `{ score, reason }`. We exercise the wrapper plus the underlying llmJudge
 * fallback behaviour so that judge failures and bad responses don't crash a
 * scoring run.
 */

/**
 * @param judge An object exposing `generate({ prompt })` like `AgentLike`.
 */
function mockJudge(generate: (args: { prompt: string }) => Promise<unknown>) {
    return { generate };
}

const rctfPrompt = {
    prompt: "You are a CFO. Given Q4 numbers, draft a board memo.",
    structured: {
        role: "CFO",
        context: "Q4 numbers",
        task: "draft a board memo",
        format: "memo",
    },
};

describe("rctfCompletenessScorer", () => {
    test("identity defaults", () => {
        const scorer = rctfCompletenessScorer({
            judge: mockJudge(async () => ({ text: '{"score":1,"reason":"ok"}' })),
        });
        expect(scorer.id).toBe("rctf-completeness");
        expect(scorer.name).toBe("R-C-T-F Completeness");
        expect(scorer.description).toContain("Role");
    });

    test("passes the extracted prompt JSON into the judge prompt", async () => {
        let receivedPrompt = "";
        const scorer = rctfCompletenessScorer({
            judge: mockJudge(async ({ prompt }) => {
                receivedPrompt = prompt;
                return { text: '{"score": 1.0, "reason": "all slots filled"}' };
            }),
        });
        await scorer.score({ input: "n/a", output: rctfPrompt as unknown });
        // The wrapper serialises the output to JSON and embeds it in the
        // prompt body verbatim.
        expect(receivedPrompt).toContain("R-C-T-F backbone");
        expect(receivedPrompt).toContain("\"role\": \"CFO\"");
        expect(receivedPrompt).toContain("\"task\": \"draft a board memo\"");
    });

    test("returns the parsed score for a complete prompt", async () => {
        const scorer = rctfCompletenessScorer({
            judge: mockJudge(async () => ({
                text: '{"score": 0.92, "reason": "Role and Format are crisp"}',
            })),
        });
        const result = await scorer.score({ input: "", output: rctfPrompt as unknown });
        expect(result.score).toBe(0.92);
        expect(result.reason).toBe("Role and Format are crisp");
    });

    test("low score with reason when slots are missing (judge says 0.25)", async () => {
        // Output deliberately missing R, T, F.
        const sparse = {
            prompt: "Make a thing.",
            structured: { role: "", context: "Some background", task: "", format: "" },
        };
        const scorer = rctfCompletenessScorer({
            judge: mockJudge(async () => ({
                text: '{"score": 0.25, "reason": "Only Context is filled — missing Role/Task/Format"}',
            })),
        });
        const result = await scorer.score({ input: "", output: sparse as unknown });
        expect(result.score).toBe(0.25);
        expect(result.reason).toContain("missing Role");
    });

    test("accepts judges that return plain strings (not { text })", async () => {
        const scorer = rctfCompletenessScorer({
            judge: mockJudge(async () => '{"score": 0.5, "reason": "string return"}' as unknown),
        });
        const result = await scorer.score({ input: "", output: rctfPrompt as unknown });
        expect(result.score).toBe(0.5);
        expect(result.reason).toBe("string return");
    });

    test("handles judge returning extra prose around the JSON object", async () => {
        const scorer = rctfCompletenessScorer({
            judge: mockJudge(async () => ({
                text: 'Here is my evaluation:\n\n{"score": 0.7, "reason": "decent"}\n\nThanks!',
            })),
        });
        const result = await scorer.score({ input: "", output: rctfPrompt as unknown });
        expect(result.score).toBe(0.7);
        expect(result.reason).toBe("decent");
    });
});

describe("rctfCompletenessScorer — judge failure modes", () => {
    test("invalid JSON => fallback score 0 with explanatory reason", async () => {
        const scorer = rctfCompletenessScorer({
            judge: mockJudge(async () => ({ text: "I think it's pretty good?" })),
        });
        const result = await scorer.score({ input: "", output: rctfPrompt as unknown });
        expect(result.score).toBe(0);
        expect(result.reason).toContain("Failed to parse");
    });

    test("empty judge response => fallback score 0", async () => {
        const scorer = rctfCompletenessScorer({
            judge: mockJudge(async () => ({ text: "" })),
        });
        const result = await scorer.score({ input: "", output: rctfPrompt as unknown });
        expect(result.score).toBe(0);
    });

    test("score above 1 is clamped to 1", async () => {
        const scorer = rctfCompletenessScorer({
            judge: mockJudge(async () => ({ text: '{"score": 2.5, "reason": "out of range"}' })),
        });
        const result = await scorer.score({ input: "", output: rctfPrompt as unknown });
        expect(result.score).toBe(1);
        expect(result.reason).toBe("out of range");
    });

    test("score below 0 is clamped to 0", async () => {
        const scorer = rctfCompletenessScorer({
            judge: mockJudge(async () => ({ text: '{"score": -0.4, "reason": "negative"}' })),
        });
        const result = await scorer.score({ input: "", output: rctfPrompt as unknown });
        expect(result.score).toBe(0);
    });

    test("non-numeric score => fallback score 0 with parse-failure reason", async () => {
        // The regex in llmJudge requires `"score": <number>`, so a string
        // value won't match and the parser falls through to the default.
        const scorer = rctfCompletenessScorer({
            judge: mockJudge(async () => ({ text: '{"score": "high", "reason": "bad format"}' })),
        });
        const result = await scorer.score({ input: "", output: rctfPrompt as unknown });
        expect(result.score).toBe(0);
        expect(result.reason).toContain("Failed to parse");
    });

    test("NaN score => clamped to 0", async () => {
        // The regex matches `\d.+`, so this won't match. Documenting that NaN
        // is filtered to 0 by the safety net.
        const scorer = rctfCompletenessScorer({
            judge: mockJudge(async () => ({ text: '{"score": NaN, "reason": "?"}' })),
        });
        const result = await scorer.score({ input: "", output: rctfPrompt as unknown });
        expect(result.score).toBe(0);
    });

    test("judge timeout / generic rejection propagates to caller", async () => {
        // The scorer does not catch judge errors — they bubble up to the
        // caller. This is the documented behaviour: timeouts/runtime errors
        // are NOT silenced; the orchestrator decides whether to retry.
        const scorer = rctfCompletenessScorer({
            judge: mockJudge(async () => {
                throw new Error("judge timeout after 30s");
            }),
        });
        await expect(scorer.score({ input: "", output: rctfPrompt as unknown }))
            .rejects.toThrow("judge timeout after 30s");
    });
});

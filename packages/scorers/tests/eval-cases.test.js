import { describe, expect, test } from "bun:test";
import {
  EVAL_PASS_THRESHOLD,
  evalAssertionScorer,
  evalCaseRunId,
  evaluateEvalCase,
  evaluateEvalCaseAsync,
  parseEvalDataset,
} from "../src/evalCases.js";
import { llmJudge } from "../src/llmJudge.js";

describe("EVAL_PASS_THRESHOLD", () => {
  test("is the stable, documented constant", () => {
    expect(EVAL_PASS_THRESHOLD).toBe(0.8);
  });
});

// ---------------------------------------------------------------------------
// parseEvalDataset — fixtures copied verbatim from multi's
// src/evals/evalReport.test.ts so the client (author-time parse) and this
// server-side module agree byte-for-byte.
// ---------------------------------------------------------------------------
describe("parseEvalDataset", () => {
  test("parses a JSON array of {id, input, expected} rows", () => {
    const result = parseEvalDataset(
      JSON.stringify([
        { id: "c1", input: "2+2", expected: "4" },
        { id: "c2", input: "3+3", expected: "6" },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cases).toEqual([
      { id: "c1", name: undefined, input: "2+2", expected: "4" },
      { id: "c2", name: undefined, input: "3+3", expected: "6" },
    ]);
  });

  test("parses JSONL (one JSON object per line), skipping blank lines and # comments", () => {
    const text = ['{"id": "c1", "input": "a"}', "", "# a comment", '{"id": "c2", "input": "b"}'].join("\n");
    const result = parseEvalDataset(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cases.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  test("falls back to the row itself as input when no explicit input field exists", () => {
    const result = parseEvalDataset(JSON.stringify([{ id: "c1", prompt: "hi", expected: "hello" }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cases[0]).toEqual({ id: "c1", name: undefined, input: { prompt: "hi" }, expected: "hello" });
  });

  test("does not leak a top-level judge assertion into fallback workflow input", () => {
    const result = parseEvalDataset(
      JSON.stringify([{ id: "c1", prompt: "hi", judge: { instructions: "Reply politely" } }]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cases[0].input).toEqual({ prompt: "hi" });
    expect(result.cases[0].judge).toEqual({ instructions: "Reply politely", threshold: EVAL_PASS_THRESHOLD });
  });

  test("derives a positional id when neither id nor name is present", () => {
    const result = parseEvalDataset(JSON.stringify([{ input: "a" }, { input: "b" }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cases.map((c) => c.id)).toEqual(["case-1", "case-2"]);
  });

  test("falls back to name when id is absent", () => {
    const result = parseEvalDataset(JSON.stringify([{ name: "addition", input: "2+2" }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cases[0].id).toBe("addition");
  });

  test("parses judge assertions and defaults their threshold", () => {
    const result = parseEvalDataset(
      JSON.stringify([
        { id: "default", input: "a", judge: { instructions: "Be polite" } },
        { id: "custom", input: "b", judge: { instructions: "Mention the deadline", threshold: 0.7 } },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cases[0].judge).toEqual({ instructions: "Be polite", threshold: EVAL_PASS_THRESHOLD });
    expect(result.cases[1].judge).toEqual({ instructions: "Mention the deadline", threshold: 0.7 });
  });

  test("rejects judge assertions with missing or blank instructions", () => {
    for (const judge of [{}, { instructions: "   " }]) {
      const result = parseEvalDataset(JSON.stringify([{ id: "bad", input: "a", judge }]));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("judge.instructions must be a non-empty string");
      }
    }
  });

  test("rejects judge thresholds outside 0..1 or with the wrong type", () => {
    for (const threshold of [-0.01, 1.01, "0.7", null]) {
      const result = parseEvalDataset(
        JSON.stringify([{ id: "bad", input: "a", judge: { instructions: "Be correct", threshold } }]),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("judge.threshold must be a number between 0 and 1");
      }
    }
  });

  test("rejects empty text", () => {
    expect(parseEvalDataset("")).toEqual({ ok: false, error: "Dataset is empty." });
    expect(parseEvalDataset("   \n  ")).toEqual({ ok: false, error: "Dataset is empty." });
  });

  test("rejects an empty array", () => {
    const result = parseEvalDataset("[]");
    expect(result).toEqual({ ok: false, error: "Dataset has no cases." });
  });

  test("rejects malformed JSON that also fails as JSONL", () => {
    const result = parseEvalDataset("{not: valid json,,,");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Could not parse/);
  });

  test("rejects a bare JSON object at the top level (not an array)", () => {
    const result = parseEvalDataset(JSON.stringify({ id: "c1", input: "a" }));
    expect(result).toEqual({
      ok: false,
      error: "Dataset must be a JSON array of case objects (a single object is not a list).",
    });
  });

  test("rejects a non-object row in an array", () => {
    const result = parseEvalDataset(JSON.stringify(["not an object"]));
    expect(result).toEqual({ ok: false, error: "Every dataset row must be a JSON object." });
  });

  test("rejects duplicate case ids with the offending id and row number", () => {
    const result = parseEvalDataset(
      JSON.stringify([
        { id: "dup", input: "a" },
        { id: "dup", input: "b" },
      ]),
    );
    expect(result).toEqual({ ok: false, error: 'Duplicate case id "dup" (row 2).' });
  });
});

// ---------------------------------------------------------------------------
// evaluateEvalCase
// ---------------------------------------------------------------------------
describe("evaluateEvalCase — expected OUTPUT value mode", () => {
  test("no expected key at all: passes on completion alone (a single implicit assertion, no output compare)", () => {
    const result = evaluateEvalCase({ status: "finished", output: { anything: true } });
    expect(result.passed).toBe(true);
    expect(result.assertions).toHaveLength(1);
    expect(result.assertions[0].passed).toBe(true);

    const failed = evaluateEvalCase({ status: "failed", output: null });
    expect(failed.passed).toBe(false);
    expect(failed.assertions).toHaveLength(1);
  });

  test("scalar expected: deep equal", () => {
    const ok = evaluateEvalCase({ expected: "4", status: "finished", output: "4" });
    expect(ok.passed).toBe(true);
    const bad = evaluateEvalCase({ expected: "4", status: "finished", output: "5" });
    expect(bad.passed).toBe(false);
  });

  test("object/array expected: subset match", () => {
    const result = evaluateEvalCase({
      expected: { answer: 4 },
      status: "finished",
      output: { answer: 4, extra: "ignored" },
    });
    expect(result.passed).toBe(true);
  });

  test("a non-finished status fails the implicit completion assertion even if output matches", () => {
    const result = evaluateEvalCase({ expected: "4", status: "failed", output: "4" });
    expect(result.passed).toBe(false);
    expect(result.assertions[0]).toEqual({ description: "case run finished", passed: false });
  });
});

describe("evaluateEvalCase — inconclusive stamping (harness vs product failures)", () => {
  test("a case that died on a known infra signature is failed AND inconclusive", () => {
    for (const error of [
      "SmithersError TOOL_NETWORK_DISABLED: Network access is disabled for the bash tool.",
      "connect ECONNREFUSED 127.0.0.1:5432",
      "getaddrinfo ENOTFOUND db.localhost",
      "error:0A000410:SSL routines::sslv3 alert handshake failure",
      "spawn wallet-simulator ENOENT",
      "JavaScript heap out of memory",
      "429 rate limit exceeded, retry later",
    ]) {
      const result = evaluateEvalCase({ status: "error", error });
      expect(result.passed).toBe(false);
      expect(result.inconclusive).toBe(true);
    }
  });

  test("an unrecognized error stays a genuine failure (fail-closed)", () => {
    const result = evaluateEvalCase({ status: "failed", error: "assertion failed: expected 4, got 5" });
    expect(result.passed).toBe(false);
    expect(result.inconclusive).toBe(false);
  });

  test("a case that expected a non-finished status is never inconclusive", () => {
    // The dataset asked for an error: reaching one is on-contract, and a
    // status mismatch is a real grading result, not a harness fault.
    const result = evaluateEvalCase({
      expected: { status: "failed", errorContains: "boom" },
      status: "finished",
      output: null,
    });
    expect(result.inconclusive).toBe(false);
  });

  test("a passing case is never inconclusive", () => {
    const result = evaluateEvalCase({ status: "finished", output: null });
    expect(result.passed).toBe(true);
    expect(result.inconclusive).toBe(false);
  });

  test("a finished run with a wrong output is a genuine failure, not inconclusive", () => {
    const result = evaluateEvalCase({
      expected: "4",
      status: "finished",
      output: "5",
      error: "connect ECONNREFUSED 127.0.0.1:1 (stale log line in output)",
    });
    expect(result.passed).toBe(false);
    expect(result.inconclusive).toBe(false);
  });
});

describe("evaluateEvalCase — assertion-spec mode ({status, output, outputContains, errorContains})", () => {
  test("defaults status to finished when expected is undefined", () => {
    const result = evaluateEvalCase({ status: "finished", output: null });
    expect(result.passed).toBe(true);
  });

  test("status assertion", () => {
    const ok = evaluateEvalCase({ expected: { status: "failed" }, status: "failed", output: null });
    expect(ok.passed).toBe(true);
    const bad = evaluateEvalCase({ expected: { status: "failed" }, status: "finished", output: null });
    expect(bad.passed).toBe(false);
  });

  test("output exact-match assertion", () => {
    const result = evaluateEvalCase({
      expected: { status: "finished", output: { a: 1 } },
      status: "finished",
      output: { a: 1 },
    });
    expect(result.passed).toBe(true);
  });

  test("outputContains assertion (subset)", () => {
    const result = evaluateEvalCase({
      expected: { outputContains: { a: 1 } },
      status: "finished",
      output: { a: 1, b: 2 },
    });
    expect(result.passed).toBe(true);
  });

  test("errorContains assertion", () => {
    const result = evaluateEvalCase({
      expected: { status: "failed", errorContains: "boom" },
      status: "failed",
      output: null,
      error: new Error("it went boom loudly"),
    });
    expect(result.passed).toBe(true);
  });

  test("a failed/cancelled child run fails its status assertion and preserves the error", () => {
    const result = evaluateEvalCase({
      expected: { status: "finished" },
      status: "failed",
      output: null,
      error: "child workflow threw",
    });
    expect(result.passed).toBe(false);
  });

  test("an unparsable assertion spec degrades to a single failed assertion (never throws)", () => {
    const result = evaluateEvalCase({ expected: { status: "not-a-real-status" }, status: "finished", output: null });
    expect(result.passed).toBe(false);
    expect(result.assertions).toHaveLength(1);
    expect(result.assertions[0].passed).toBe(false);
  });
});

describe("evaluateEvalCaseAsync — LLM-judge assertions", () => {
  test("combines deterministic assertions and passes a fake llmJudge score equal to the threshold", async () => {
    const fakeJudge = {
      generate: async () => ({ text: '{"score":0.7,"reason":"Polite and names Friday."}' }),
    };
    const result = await evaluateEvalCaseAsync(
      {
        expected: { outputContains: { summary: "Friday" } },
        judge: { instructions: "Be polite and mention the deadline", threshold: 0.7 },
        input: { prompt: "Summarize" },
        status: "finished",
        output: { summary: "Friday" },
      },
      async ({ input, output }) => {
        const scorer = llmJudge({
          id: "fake-eval-judge",
          name: "Fake Eval Judge",
          description: "Test judge",
          judge: fakeJudge,
          instructions: "Return a JSON score and reason.",
          promptTemplate: () => JSON.stringify({ input, output }),
        });
        return scorer.score({ input, output });
      },
    );

    expect(result.passed).toBe(true);
    expect(result.assertions).toHaveLength(3);
    expect(result.assertions.at(-1)).toEqual({
      description: "LLM judge score >= 0.7: Be polite and mention the deadline",
      passed: true,
      score: 0.7,
      reason: "Polite and names Friday.",
    });
  });

  test("fails only the judge assertion when its score is below threshold", async () => {
    const result = await evaluateEvalCaseAsync(
      {
        judge: { instructions: "Mention the deadline" },
        status: "finished",
        output: "A summary without a date",
      },
      async () => ({ score: 0.7, reason: "No deadline was named." }),
    );

    expect(result.passed).toBe(false);
    expect(result.assertions[0].passed).toBe(true);
    expect(result.assertions.at(-1)).toMatchObject({
      passed: false,
      score: 0.7,
      reason: "No deadline was named.",
    });
  });
});

// ---------------------------------------------------------------------------
// evalCaseRunId
// ---------------------------------------------------------------------------
describe("evalCaseRunId", () => {
  test("is readable and stable for the same inputs", () => {
    const id = evalCaseRunId("my-suite", "case-1", "eval-run-abc");
    expect(id).toBe(evalCaseRunId("my-suite", "case-1", "eval-run-abc"));
    expect(id).toMatch(/^evalcase-/);
    expect(id.length).toBeLessThanOrEqual(64);
  });

  test("two different eval runs of the same suite/case never collide", () => {
    const a = evalCaseRunId("suite", "case-1", "run-a");
    const b = evalCaseRunId("suite", "case-1", "run-b");
    expect(a).not.toBe(b);
  });

  test("caps long ids", () => {
    const id = evalCaseRunId(
      "a-very-long-suite-name-that-keeps-going-and-going",
      "a-very-long-case-name-that-keeps-going-and-going",
      "a-very-long-eval-run-id-that-keeps-going-and-going",
    );
    expect(id.length).toBeLessThanOrEqual(64);
  });
});

// ---------------------------------------------------------------------------
// evalAssertionScorer
// ---------------------------------------------------------------------------
describe("evalAssertionScorer", () => {
  test("scores 1 for an all-passed row", async () => {
    const scorer = evalAssertionScorer();
    expect(scorer.id).toBe("eval-assertions");
    const result = await scorer.score({
      output: {
        assertions: [
          { description: "a", passed: true },
          { description: "b", passed: true },
        ],
      },
      input: null,
    });
    expect(result.score).toBe(1);
  });

  test("scores 0 with a reason naming the failed assertions", async () => {
    const scorer = evalAssertionScorer();
    const result = await scorer.score({
      output: {
        assertions: [
          { description: "a", passed: true },
          { description: "b", passed: false },
        ],
      },
      input: null,
    });
    expect(result.score).toBe(0);
    expect(result.reason).toContain("b");
  });

  test("scores 1 when there are no assertions (completion-only pass)", async () => {
    const scorer = evalAssertionScorer();
    const result = await scorer.score({ output: { assertions: [] }, input: null });
    expect(result.score).toBe(1);
  });

  test("score is always finite 0..1 even for a malformed output row", async () => {
    const scorer = evalAssertionScorer();
    const result = await scorer.score({ output: null, input: null });
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});

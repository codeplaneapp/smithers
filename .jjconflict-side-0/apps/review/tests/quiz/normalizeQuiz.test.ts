import { describe, expect, test } from "bun:test";
import { normalizeQuiz } from "../../src/quiz/normalizeQuiz.ts";

const changedPaths = ["src/app.ts", "src/other.ts"];

function question(overrides: Record<string, unknown> = {}) {
  return {
    question: "What breaks when value is undefined?",
    options: ["A crash in render", "Nothing", "A silent fallback"],
    correctIndex: 0,
    explanation: "render dereferences value without a guard.",
    path: "src/app.ts",
    ...overrides,
  };
}

describe("normalizeQuiz", () => {
  test("valid quiz passes through", () => {
    const quiz = normalizeQuiz(
      {
        impact: { level: "high", reasons: [{ signal: "critical finding", path: "src/app.ts" }] },
        questions: [question()],
      },
      changedPaths,
    );
    expect(quiz).not.toBeNull();
    expect(quiz!.impact.level).toBe("high");
    expect(quiz!.questions).toHaveLength(1);
    expect(quiz!.questions[0].correctIndex).toBe(0);
  });

  test("non-object input returns null", () => {
    expect(normalizeQuiz(null, changedPaths)).toBeNull();
    expect(normalizeQuiz(undefined, changedPaths)).toBeNull();
    expect(normalizeQuiz(42, changedPaths)).toBeNull();
    expect(normalizeQuiz("quiz", changedPaths)).toBeNull();
    expect(normalizeQuiz([question()], changedPaths)).toBeNull();
  });

  test("garbage-typed fields return null instead of throwing", () => {
    expect(normalizeQuiz({ impact: "very bad", questions: "none" }, changedPaths)).toBeNull();
    expect(normalizeQuiz({ questions: [{ question: 42, options: {} }] }, changedPaths)).toBeNull();
  });

  test("empty object parses via defaults but has zero questions, so null", () => {
    expect(normalizeQuiz({}, changedPaths)).toBeNull();
  });

  test("questions with fewer than 2 options are dropped", () => {
    expect(normalizeQuiz({ questions: [question({ options: ["only one"] })] }, changedPaths)).toBeNull();
    expect(normalizeQuiz({ questions: [question({ options: [] })] }, changedPaths)).toBeNull();
  });

  test("questions with more than 5 options are dropped", () => {
    expect(
      normalizeQuiz({ questions: [question({ options: ["a", "b", "c", "d", "e", "f"] })] }, changedPaths),
    ).toBeNull();
  });

  test("out-of-range correctIndex is dropped", () => {
    expect(normalizeQuiz({ questions: [question({ correctIndex: 3 })] }, changedPaths)).toBeNull();
    expect(normalizeQuiz({ questions: [question({ correctIndex: -1 })] }, changedPaths)).toBeNull();
  });

  test("empty question or explanation is dropped", () => {
    expect(normalizeQuiz({ questions: [question({ question: "  " })] }, changedPaths)).toBeNull();
    expect(normalizeQuiz({ questions: [question({ explanation: "" })] }, changedPaths)).toBeNull();
  });

  test("blank option text is dropped", () => {
    expect(normalizeQuiz({ questions: [question({ options: ["real", "  "] })] }, changedPaths)).toBeNull();
  });

  test("path outside the change set is dropped; empty path is allowed", () => {
    expect(normalizeQuiz({ questions: [question({ path: "src/unrelated.ts" })] }, changedPaths)).toBeNull();
    const quiz = normalizeQuiz({ questions: [question({ path: "" })] }, changedPaths);
    expect(quiz!.questions[0].path).toBe("");
  });

  test("clamps to 6 questions", () => {
    const questions = Array.from({ length: 9 }, (_, i) =>
      question({ question: `Distinct question number ${i} about a different aspect?` }),
    );
    const quiz = normalizeQuiz({ questions }, changedPaths);
    expect(quiz!.questions).toHaveLength(6);
  });

  test("near-identical duplicate questions are deduped, keeping the first", () => {
    const quiz = normalizeQuiz(
      {
        questions: [
          question({ question: "What breaks when value is undefined?" }),
          question({ question: "What breaks when value is undefined??!" }),
          question({ question: "Which caller is affected by the new guard?" }),
        ],
      },
      changedPaths,
    );
    expect(quiz!.questions).toHaveLength(2);
    expect(quiz!.questions[0].question).toBe("What breaks when value is undefined?");
  });

  test("a shared prefix does not dedupe distinct questions", () => {
    const quiz = normalizeQuiz(
      {
        questions: [
          question({ question: "What breaks when value is null?" }),
          question({ question: "What breaks when value is null after retry?" }),
        ],
      },
      changedPaths,
    );
    expect(quiz!.questions).toHaveLength(2);
  });

  test("unicode near-duplicates dedupe when accent-stripped keys are equal", () => {
    const quiz = normalizeQuiz(
      {
        questions: [
          question({ question: "What breaks when café is renamed?" }),
          question({ question: "What breaks when cafe is renamed?" }),
        ],
      },
      changedPaths,
    );
    expect(quiz!.questions).toHaveLength(1);
  });

  test("distinct CJK questions with empty normalized keys are not deduped", () => {
    const quiz = normalizeQuiz(
      {
        questions: [
          question({ question: "値が未定義のとき何が壊れますか？" }),
          question({ question: "どの呼び出し元が影響を受けますか？" }),
        ],
      },
      changedPaths,
    );
    expect(quiz!.questions).toHaveLength(2);
  });

  test("10,000 questions return 6 quickly", () => {
    const questions = Array.from({ length: 10_000 }, (_, i) =>
      question({ question: `Distinct question number ${i} about a unique aspect of the change?` }),
    );
    const start = performance.now();
    const quiz = normalizeQuiz({ questions }, changedPaths);
    const elapsed = performance.now() - start;
    expect(quiz!.questions).toHaveLength(6);
    expect(elapsed).toBeLessThan(1_000);
  });

  test("mixed valid and invalid questions keeps only the valid ones", () => {
    const quiz = normalizeQuiz(
      {
        questions: [
          question(),
          question({ question: "Bad index question about the other file?", correctIndex: 99, path: "src/other.ts" }),
          question({ question: "Which caller is affected by the new guard?", path: "src/other.ts" }),
        ],
      },
      changedPaths,
    );
    expect(quiz!.questions.map((entry) => entry.path)).toEqual(["src/app.ts", "src/other.ts"]);
  });

  test("trims whitespace on question, options, explanation, and path", () => {
    const quiz = normalizeQuiz(
      {
        questions: [
          question({
            question: "  What breaks when value is undefined?  ",
            options: [" A crash in render ", " Nothing "],
            explanation: "  because.  ",
            path: " src/app.ts ",
          }),
        ],
      },
      changedPaths,
    );
    expect(quiz!.questions[0].question).toBe("What breaks when value is undefined?");
    expect(quiz!.questions[0].options).toEqual(["A crash in render", "Nothing"]);
    expect(quiz!.questions[0].explanation).toBe("because.");
    expect(quiz!.questions[0].path).toBe("src/app.ts");
  });

  test("missing impact defaults to low with no reasons", () => {
    const quiz = normalizeQuiz({ questions: [question()] }, changedPaths);
    expect(quiz!.impact).toEqual({ level: "low", reasons: [] });
  });

  test("invalid impact level fails the parse and returns null", () => {
    expect(normalizeQuiz({ impact: { level: "apocalyptic" }, questions: [question()] }, changedPaths)).toBeNull();
  });
});

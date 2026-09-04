import { describe, expect, test } from "bun:test";
import { buildPullRequestReview } from "../src/github/buildPullRequestReview.ts";
import type { PullRequestFile } from "../src/github/listPullRequestFiles.ts";

const story = {
  headline: "Adds the widget",
  synopsis: "First the core, then the tests.",
  chapters: [
    {
      title: "The core",
      blocks: [
        { kind: "prose", text: "Start here; the widget is born.", path: "", intro: "", title: "", mermaid: "" },
        { kind: "diff", path: "src/widget.ts", intro: "the widget itself", text: "", title: "", mermaid: "" },
        { kind: "diagram", title: "Flow", mermaid: "graph TD; A-->B", text: "", path: "", intro: "" },
      ],
    },
  ],
};

function finding(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    path: "src/widget.ts",
    content: "Possible off-by-one.",
    suggestionCode: "",
    existingCode: "",
    startLine: 0,
    endLine: 0,
    thinking: "",
    severity: "minor",
    category: "correctness",
    confidence: "plausible",
    ...overrides,
  } as never;
}

function prFile(
  filename: string,
  lines: number[],
  overrides: Partial<PullRequestFile> = {},
): [string, PullRequestFile] {
  return [filename, { filename, additions: 5, deletions: 2, commentableLines: new Set(lines), ...overrides }];
}

const widgetFiles = new Map<string, PullRequestFile>([prFile("src/widget.ts", [1, 2, 3, 4, 10, 11, 12, 13, 14])]);

describe("buildPullRequestReview", () => {
  test("anchors findings on commentable lines; folds the rest into the body", () => {
    const payload = buildPullRequestReview({
      story,
      findings: [
        finding({ startLine: 4, endLine: 4, severity: "major" }),
        finding({ startLine: 10, endLine: 14, suggestionCode: "fixed();" }),
        finding({ content: "No line numbers.", severity: "critical" }),
        finding({ path: "not/in/pr.ts", startLine: 2, endLine: 2, content: "Outside the PR." }),
      ],
      prFiles: widgetFiles,
      headSha: "abc123",
      walkthroughUrl: "https://review.jjhub.tech/w/xyz",
    });

    expect(payload.commit_id).toBe("abc123");
    expect(payload.event).toBe("COMMENT");
    expect(payload.comments).toHaveLength(2);
    expect(payload.comments[0].path).toBe("src/widget.ts");
    expect(payload.comments[0].line).toBe(4);
    expect(payload.comments[0].side).toBe("RIGHT");
    expect(payload.comments[0].body).toContain("🔴 **major** · correctness");
    expect(payload.comments[0].body).toContain("Possible off-by-one.");
    expect(payload.comments[1].start_line).toBe(10);
    expect(payload.comments[1].line).toBe(14);
    expect(payload.comments[1].body).toContain("🟡 **minor** · correctness");
    expect(payload.comments[1].body).toContain("```suggestion\nfixed();\n```");

    expect(payload.body).toContain("smithers review — Adds the widget");
    expect(payload.body).toContain("**📖 Full walkthrough:** https://review.jjhub.tech/w/xyz");
    expect(payload.body).toContain("**1. The core**");
    expect(payload.body).toContain("`src/widget.ts` — the widget itself");
    expect(payload.body).toContain("Start here; the widget is born.");
    expect(payload.body).toContain("📊 1 diagram in the full walkthrough");
    expect(payload.body).toContain("2 findings without an inline anchor");
    expect(payload.body).toContain("No line numbers.");
    expect(payload.body).toContain("Outside the PR.");
    expect(payload.body).toContain("4 findings · 2 inline");
  });

  test("the marker is the first line of the body", () => {
    const payload = buildPullRequestReview({
      story,
      findings: [],
      prFiles: widgetFiles,
      headSha: "abc123",
    });
    expect(payload.body.split("\n")[0]).toBe("<!-- smithers-review -->");
  });

  test("severity emoji prefix on every inline comment", () => {
    const payload = buildPullRequestReview({
      story,
      findings: [
        finding({ startLine: 1, endLine: 1, severity: "critical", category: "security" }),
        finding({ startLine: 2, endLine: 2, severity: "info", category: "docs" }),
      ],
      prFiles: widgetFiles,
      headSha: "abc123",
    });
    expect(payload.comments[0].body.startsWith("💥 **critical** · security")).toBe(true);
    expect(payload.comments[1].body.startsWith("ℹ️ **info** · docs")).toBe(true);
  });

  test("a multi-line range crossing uncommentable lines degrades to the end line", () => {
    const payload = buildPullRequestReview({
      story,
      // Lines 5..9 are not in the diff; the range 3..10 cannot anchor whole.
      findings: [finding({ startLine: 3, endLine: 10 })],
      prFiles: widgetFiles,
      headSha: "abc123",
    });
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0].line).toBe(10);
    expect(payload.comments[0].start_line).toBeUndefined();
  });

  test("a degraded multi-line anchor never emits a suggestion block", () => {
    const payload = buildPullRequestReview({
      story,
      // The anchor collapses to line 10; applying a 8-line suggestion there
      // would corrupt the file, so it must render as a plain fenced block.
      findings: [finding({ startLine: 3, endLine: 10, suggestionCode: "const a = 1;\nconst b = 2;" })],
      prFiles: widgetFiles,
      headSha: "abc123",
    });
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0].body).not.toContain("```suggestion");
    expect(payload.comments[0].body).toContain("Suggested replacement for lines 3–10:");
    expect(payload.comments[0].body).toContain("```\nconst a = 1;\nconst b = 2;\n```");
  });

  test("fully-anchored multi-line ranges keep the suggestion block", () => {
    const payload = buildPullRequestReview({
      story,
      findings: [finding({ startLine: 10, endLine: 12, suggestionCode: "fixed();" })],
      prFiles: widgetFiles,
      headSha: "abc123",
    });
    expect(payload.comments[0].start_line).toBe(10);
    expect(payload.comments[0].body).toContain("```suggestion\nfixed();\n```");
  });

  test("suggestion code containing backtick fences cannot break out of its fence", () => {
    const evil = "code();\n```\n**injected markdown**\n```suggestion\nmore();";
    const payload = buildPullRequestReview({
      story,
      findings: [finding({ startLine: 4, endLine: 4, suggestionCode: evil })],
      prFiles: widgetFiles,
      headSha: "abc123",
    });
    // A four-backtick fence contains the three-backtick runs in the content.
    expect(payload.comments[0].body).toContain(`\`\`\`\`suggestion\n${evil}\n\`\`\`\``);
    expect(payload.comments[0].body.endsWith("````")).toBe(true);
  });

  test("a finding whose line is not commentable goes to the body list", () => {
    const payload = buildPullRequestReview({
      story,
      findings: [finding({ startLine: 7, endLine: 7, content: "Deleted-side note." })],
      prFiles: widgetFiles,
      headSha: "abc123",
    });
    expect(payload.comments).toHaveLength(0);
    expect(payload.body).toContain("Deleted-side note.");
    expect(payload.body).toContain("1 finding without an inline anchor");
  });

  test("unanchored findings group by severity with minor and info collapsed", () => {
    const payload = buildPullRequestReview({
      story,
      findings: [
        finding({ content: "Critical thing.", severity: "critical" }),
        finding({ content: "Major thing.", severity: "major" }),
        finding({ content: "Minor thing.", severity: "minor" }),
        finding({ content: "Info thing.", severity: "info" }),
      ],
      prFiles: widgetFiles,
      headSha: "abc123",
    });
    expect(payload.body).toContain("**💥 critical (1)**");
    expect(payload.body).toContain("**🔴 major (1)**");
    expect(payload.body).toContain("<summary>🟡 minor (1)</summary>");
    expect(payload.body).toContain("<summary>ℹ️ info (1)</summary>");
    expect(payload.body).toContain("### Findings: 💥 1 critical · 🔴 1 major · 🟡 1 minor · ℹ️ 1 info");
    const criticalAt = payload.body.indexOf("Critical thing.");
    const minorAt = payload.body.indexOf("Minor thing.");
    expect(criticalAt).toBeGreaterThan(-1);
    expect(minorAt).toBeGreaterThan(criticalAt);
  });

  test("renders a file summary table with stats and findings counts", () => {
    const payload = buildPullRequestReview({
      story,
      findings: [finding({ startLine: 1, endLine: 1 }), finding({ startLine: 2, endLine: 2 })],
      prFiles: new Map([
        prFile("src/widget.ts", [1, 2], { additions: 12, deletions: 3 }),
        prFile("docs/readme.md", [], { additions: 1, deletions: 0 }),
      ]),
      headSha: "abc123",
    });
    expect(payload.body).toContain("| File | +/- | Findings |");
    expect(payload.body).toContain("| `src/widget.ts` | +12 −3 | 2 |");
    expect(payload.body).toContain("| `docs/readme.md` | +1 −0 |  |");
  });

  const quizQuestion = {
    question: "What breaks when value is 0?",
    options: ["Nothing", "The widget loop"],
    correctIndex: 1,
    explanation: "The loop guard divides by value.",
    path: "src/widget.ts",
  };

  test("renders the quiz collapsed with the impact level and top reasons", () => {
    const payload = buildPullRequestReview({
      story,
      findings: [],
      prFiles: widgetFiles,
      headSha: "abc123",
      quiz: {
        impact: {
          level: "high",
          reasons: [
            { signal: "Touches the payment path", path: "src/widget.ts" },
            { signal: "Changes a public API", path: "" },
            { signal: "No test coverage for the new branch", path: "src/widget.ts" },
            { signal: "A fourth reason that must not render", path: "" },
          ],
        },
        questions: [quizQuestion],
      },
    });
    expect(payload.body).toContain("<summary>🧠 Reviewer quiz (1 question — high impact)");
    expect(payload.body).toContain("**Why this change matters:**");
    expect(payload.body).toContain("- Touches the payment path (`src/widget.ts`)");
    expect(payload.body).toContain("- Changes a public API");
    expect(payload.body).toContain("- No test coverage for the new branch");
    expect(payload.body).not.toContain("A fourth reason that must not render");
    // The reasons list renders above question 1.
    expect(payload.body.indexOf("Touches the payment path")).toBeLessThan(
      payload.body.indexOf("**1. What breaks when value is 0?**"),
    );
  });

  test("inline answers render only when there is no walkthrough url", () => {
    const payload = buildPullRequestReview({
      story,
      findings: [],
      prFiles: widgetFiles,
      headSha: "abc123",
      quiz: {
        impact: { level: "high", reasons: [] },
        questions: [quizQuestion],
      },
    });
    expect(payload.body).toContain("**1. What breaks when value is 0?** (`src/widget.ts`)");
    expect(payload.body).toContain("- A. Nothing");
    expect(payload.body).toContain("- B. The widget loop");
    expect(payload.body).toContain("<summary>Answer</summary>");
    expect(payload.body).toContain("**B. The widget loop**");
    expect(payload.body).toContain("The loop guard divides by value.");
    expect(payload.body).not.toContain("Answer in the walkthrough");
  });

  test("with a walkthrough url the answers are hidden behind the walkthrough link", () => {
    const payload = buildPullRequestReview({
      story,
      findings: [],
      prFiles: widgetFiles,
      headSha: "abc123",
      walkthroughUrl: "https://review.jjhub.tech/w/xyz",
      quiz: {
        impact: { level: "moderate", reasons: [] },
        questions: [quizQuestion],
      },
    });
    expect(payload.body).toContain("<summary>🧠 Reviewer quiz (1 question — moderate impact)");
    expect(payload.body).toContain("- A. Nothing");
    expect(payload.body).toContain("Answer in the walkthrough → https://review.jjhub.tech/w/xyz");
    expect(payload.body).not.toContain("<summary>Answer</summary>");
    expect(payload.body).not.toContain("**B. The widget loop**");
    expect(payload.body).not.toContain("The loop guard divides by value.");
    expect(payload.body).toContain("[Take the quiz in the walkthrough](https://review.jjhub.tech/w/xyz)");
  });

  test("no quiz section when the quiz is null or empty", () => {
    const withoutQuiz = buildPullRequestReview({
      story,
      findings: [],
      prFiles: widgetFiles,
      headSha: "abc123",
      quiz: null,
    });
    expect(withoutQuiz.body).not.toContain("Reviewer quiz");
  });

  test("degraded review is honest: failed file reviews are named, no clean-pass footer", () => {
    const payload = buildPullRequestReview({
      story,
      findings: [],
      prFiles: widgetFiles,
      headSha: "abc123",
      reviewStatus: "completed_with_warnings",
      warnings: [
        { file: "src/widget.ts", message: "no output", type: "subtask_error" },
        { file: "src/other.ts", message: "no output", type: "subtask_error" },
        { file: "", message: "deduped", type: "duplicate_comment" },
      ],
    });
    expect(payload.body).toContain("**Review degraded:** 2 file reviews failed");
    expect(payload.body).toContain("Do not treat this as a clean pass");
    expect(payload.body).toContain("0 findings · 0 inline · ⚠️ 2 file reviews failed");
    expect(payload.body).not.toContain("No comments generated");
  });

  test("completed_with_warnings without failed subtasks gets a footer note", () => {
    const payload = buildPullRequestReview({
      story,
      findings: [],
      prFiles: widgetFiles,
      headSha: "abc123",
      reviewStatus: "completed_with_warnings",
      warnings: [{ file: "", message: "deduped", type: "duplicate_comment" }],
    });
    expect(payload.body).not.toContain("Review degraded");
    expect(payload.body).toContain("⚠️ completed with warnings; see the run log");
  });

  test("pluralizes counts correctly (1 finding, 1 inline)", () => {
    const payload = buildPullRequestReview({
      story,
      findings: [finding({ startLine: 1, endLine: 1 })],
      prFiles: widgetFiles,
      headSha: "abc123",
    });
    expect(payload.body).toContain("1 finding · 1 inline");
    expect(payload.body).not.toContain("finding(s)");
    expect(payload.body).not.toContain("diagram(s)");
    expect(payload.body).not.toContain("file(s)");
  });

  test("works with zero findings and no walkthrough url", () => {
    const payload = buildPullRequestReview({
      story,
      findings: [],
      prFiles: widgetFiles,
      headSha: "abc123",
    });
    expect(payload.comments).toEqual([]);
    expect(payload.body).not.toContain("without an inline anchor");
    expect(payload.body).not.toContain("Full walkthrough");
    expect(payload.body).toContain("0 findings · 0 inline");
  });

  test("caps the body under the GitHub limit", () => {
    const bigStory = {
      headline: "Big",
      synopsis: "x".repeat(70_000),
      chapters: [],
    };
    const payload = buildPullRequestReview({
      story: bigStory,
      findings: [],
      prFiles: new Map<string, PullRequestFile>(),
      headSha: "abc123",
    });
    expect(payload.body.length).toBeLessThan(64_000);
    expect(payload.body).toContain("…truncated");
    // The cut lands on a section boundary, not mid-paragraph: the giant
    // synopsis paragraph gets dropped whole rather than sliced in half.
    expect(payload.body).not.toContain("xxx");
    expect(payload.body.endsWith("_…truncated; see the full walkthrough._")).toBe(true);
  });

  test("truncation inside an open <details> closes it so the notice is not swallowed", () => {
    // A quiz large enough that the 60k cut lands inside the quiz <details>
    // (and the per-question answer <details>), where the old blank-line cut
    // left the disclosure open and hid the truncation notice.
    const questions = Array.from({ length: 200 }, (_, i) => ({
      question: `Question ${i}: ${"why does this branch matter ".repeat(6)}`,
      options: ["A".repeat(120), "B".repeat(120)],
      correctIndex: 0,
      explanation: "x".repeat(300),
      path: "src/widget.ts",
    }));
    const payload = buildPullRequestReview({
      story,
      findings: [],
      prFiles: new Map<string, PullRequestFile>(),
      headSha: "abc123",
      quiz: { impact: { level: "high", reasons: [] }, questions },
    });
    expect(payload.body).toContain("…truncated");
    // Every <details> opened in the kept body is closed; otherwise GitHub
    // renders the notice (and everything after) collapsed out of view.
    const open = (payload.body.match(/<details>/g) ?? []).length;
    const close = (payload.body.match(/<\/details>/g) ?? []).length;
    expect(open).toBeGreaterThan(0);
    expect(open).toBe(close);
    expect(payload.body.endsWith("_…truncated; see the full walkthrough._")).toBe(true);
  });
});

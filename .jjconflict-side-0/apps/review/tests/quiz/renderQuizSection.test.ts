import { describe, expect, test } from "bun:test";
import type { Quiz } from "../../src/quiz/quizSchema.ts";
import { renderQuizSection } from "../../src/walkthrough/renderQuizSection.ts";
import { renderWalkthroughHtml } from "../../src/walkthrough/renderWalkthroughHtml.ts";
import type { ChangedFile } from "../../src/walkthrough/changedFileSchema.ts";

function quizOf(partial: Partial<Quiz> = {}): Quiz {
  return {
    impact: { level: "low", reasons: [] },
    questions: [
      {
        question: "What changed?",
        options: ["A thing", "Another thing"],
        correctIndex: 1,
        explanation: "Because.",
        path: "src/a.ts",
      },
    ],
    ...partial,
  };
}

const anchors = new Map([["src/a.ts", "file-1"]]);

describe("renderQuizSection", () => {
  test("escapes script/attribute-breaking payloads in question, options, explanation, and path", () => {
    const html = renderQuizSection(
      quizOf({
        questions: [
          {
            question: `<script>alert(1)</script>`,
            options: [`</button><img src=x onerror=alert(2)>`, `<svg onload=alert(3)>`],
            correctIndex: 0,
            explanation: `<script>alert(4)</script>`,
            path: `"><script>alert(5)</script>`,
          },
        ],
      }),
      anchors,
    );
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<svg");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;/button&gt;&lt;img src=x onerror=alert(2)&gt;");
    expect(html).toContain("&lt;svg onload=alert(3)&gt;");
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(5)&lt;/script&gt;");
  });

  test("null, undefined, and empty question sets render nothing", () => {
    expect(renderQuizSection(null, anchors)).toBe("");
    expect(renderQuizSection(undefined, anchors)).toBe("");
    expect(renderQuizSection(quizOf({ questions: [] }), anchors)).toBe("");
  });

  test("jump link is emitted only when the path has a file anchor", () => {
    const withAnchor = renderQuizSection(quizOf(), anchors);
    expect(withAnchor).toContain('href="#file-1"');
    expect(withAnchor).toContain("jump to");

    const noAnchor = renderQuizSection(
      quizOf({
        questions: [{ question: "q", options: ["a", "b"], correctIndex: 0, explanation: "e", path: "not/changed.ts" }],
      }),
      anchors,
    );
    expect(noAnchor).not.toContain("jump to");
  });

  test("5-option question with correctIndex 4 keys the noscript answer as E and data-correct=4", () => {
    const html = renderQuizSection(
      quizOf({
        questions: [
          {
            question: "Pick",
            options: ["one", "two", "three", "four", "five"],
            correctIndex: 4,
            explanation: "e",
            path: "src/a.ts",
          },
        ],
      }),
      anchors,
    );
    expect(html).toContain('data-correct="4"');
    expect(html).toContain("<strong>E.</strong> five");
  });

  test("impact banner carries the level class and escaped reasons; empty reasons emit no list", () => {
    const html = renderQuizSection(
      quizOf({
        impact: {
          level: "critical",
          reasons: [{ signal: "<b>auth</b> touched", path: "src/auth.ts" }],
        },
      }),
      anchors,
    );
    expect(html).toContain('class="impact-banner impact-critical"');
    expect(html).toContain("&lt;b&gt;auth&lt;/b&gt; touched");
    expect(html).not.toContain("<b>auth</b>");

    const noReasons = renderQuizSection(quizOf({ impact: { level: "low", reasons: [] } }), anchors);
    expect(noReasons).not.toContain("<ul");
  });

  test("a11y contract: live regions and status role are present", () => {
    const html = renderQuizSection(quizOf(), anchors);
    expect(html).toContain('class="quiz-verdict" aria-live="polite"');
    expect(html).toContain('class="quiz-score" role="status"');
    expect(html).toContain('data-quiz-summary aria-live="polite"');
    expect(html).toContain("Copy attestation");
  });
});

describe("renderWalkthroughHtml quiz integration", () => {
  const files: ChangedFile[] = [
    {
      path: "src/a.ts",
      status: "modified",
      insertions: 1,
      deletions: 0,
      diff: "",
      reviewed: true,
      excludeReason: "",
    },
  ];
  const story = {
    headline: "h",
    synopsis: "s",
    chapters: [
      { title: "c", blocks: [{ kind: "diff", path: "src/a.ts", intro: "", text: "", title: "", mermaid: "" }] },
    ],
  };
  const base = {
    title: "t",
    story,
    files,
    comments: [] as never[],
    repoDir: "/tmp/repo",
    mode: "workspace",
    ref: "workspace",
    generatedAt: "2026-06-10T00:00:00.000Z",
  };

  test("quiz present: renders #quiz section and a TOC link to it", async () => {
    const html = await renderWalkthroughHtml({ ...base, quiz: quizOf() });
    expect(html).toContain('id="quiz"');
    expect(html).toContain('href="#quiz"');
    expect(html).toContain("Reviewer quiz");
  });

  test("quiz null: no quiz section or TOC link", async () => {
    const html = await renderWalkthroughHtml({ ...base, quiz: null });
    expect(html).not.toContain('id="quiz"');
    // The inline behavior script mentions the quiz; the markup must not.
    expect(html).not.toContain('data-spy-label="Reviewer quiz"');
    expect(html).not.toContain("Reviewer quiz<span");
  });
});

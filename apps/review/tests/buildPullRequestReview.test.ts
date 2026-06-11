import { describe, expect, test } from "bun:test";
import { buildPullRequestReview } from "../src/github/buildPullRequestReview";

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
    ...overrides,
  } as never;
}

describe("buildPullRequestReview", () => {
  test("anchors findings with lines in PR paths; folds the rest into the body", () => {
    const payload = buildPullRequestReview({
      story,
      findings: [
        finding({ startLine: 4, endLine: 4 }),
        finding({ startLine: 10, endLine: 14, suggestionCode: "fixed();" }),
        finding({ content: "No line numbers." }),
        finding({ path: "not/in/pr.ts", startLine: 2, endLine: 2, content: "Outside the PR." }),
      ],
      prPaths: new Set(["src/widget.ts"]),
      headSha: "abc123",
      walkthroughUrl: "https://review.jjhub.tech/w/xyz",
    });

    expect(payload.commit_id).toBe("abc123");
    expect(payload.event).toBe("COMMENT");
    expect(payload.comments).toHaveLength(2);
    expect(payload.comments[0]).toEqual({ path: "src/widget.ts", line: 4, side: "RIGHT", body: "Possible off-by-one." });
    expect(payload.comments[1].start_line).toBe(10);
    expect(payload.comments[1].line).toBe(14);
    expect(payload.comments[1].body).toContain("```suggestion\nfixed();\n```");

    expect(payload.body).toContain("smithers review — Adds the widget");
    expect(payload.body).toContain("**📖 Full walkthrough:** https://review.jjhub.tech/w/xyz");
    expect(payload.body).toContain("**1. The core**");
    expect(payload.body).toContain("`src/widget.ts` — the widget itself");
    expect(payload.body).toContain("Start here; the widget is born.");
    expect(payload.body).toContain("📊 1 diagram(s) in the full walkthrough");
    expect(payload.body).toContain("Findings without inline anchors (2)");
    expect(payload.body).toContain("No line numbers.");
    expect(payload.body).toContain("Outside the PR.");
    expect(payload.body).toContain("4 finding(s) · 2 inline");
  });

  test("works with zero findings and no walkthrough url", () => {
    const payload = buildPullRequestReview({
      story,
      findings: [],
      prPaths: new Set(["src/widget.ts"]),
      headSha: "abc123",
    });
    expect(payload.comments).toEqual([]);
    expect(payload.body).not.toContain("Findings without inline anchors");
    expect(payload.body).not.toContain("Full walkthrough");
    expect(payload.body).toContain("0 finding(s) · 0 inline");
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
      prPaths: new Set<string>(),
      headSha: "abc123",
    });
    expect(payload.body.length).toBeLessThan(64_000);
    expect(payload.body).toContain("…truncated");
  });
});

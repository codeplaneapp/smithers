import { afterEach, describe, expect, mock, test } from "bun:test";
import type { PullRequestReviewPayload } from "../../src/github/buildPullRequestReview";
import type { PullRequestTarget } from "../../src/github/resolvePullRequest";

type GhCall = {
  repoDir: string;
  args: string[];
  stdin?: string;
};

const ghCalls: GhCall[] = [];
const ghResponses: Array<string | Error> = [];

const runGhMock = mock(async (repoDir: string, args: string[], stdin?: string) => {
  ghCalls.push({ repoDir, args, stdin });
  const response = ghResponses.shift();
  if (response instanceof Error) throw response;
  return response ?? "";
});

mock.module("../../src/github/runGh", () => ({
  runGh: runGhMock,
}));

afterEach(() => {
  ghCalls.length = 0;
  ghResponses.length = 0;
  runGhMock.mockClear();
});

const pr: PullRequestTarget = {
  owner: "smithersai",
  repo: "smithers",
  number: 306,
  url: "https://github.com/smithersai/smithers/pull/306",
  baseRefName: "main",
  headRefName: "fix-i306-w8",
  headSha: "abc123",
};

describe("GitHub PR posting helpers", () => {
  test("resolvePullRequest resolves coordinates from gh pr view JSON", async () => {
    ghResponses.push(
      JSON.stringify({
        number: 306,
        url: "https://github.com/smithersai/smithers/pull/306",
        baseRefName: "main",
        headRefName: "fix-i306-w8",
        headRefOid: "abc123",
      }),
    );
    const { resolvePullRequest } = await import("../../src/github/resolvePullRequest");

    await expect(resolvePullRequest("/repo", "306")).resolves.toEqual(pr);
    expect(ghCalls).toEqual([
      {
        repoDir: "/repo",
        args: ["pr", "view", "306", "--json", "number,url,baseRefName,headRefName,headRefOid"],
      },
    ]);
  });

  test("resolvePullRequest rejects PR URLs that cannot identify owner and repo", async () => {
    ghResponses.push(
      JSON.stringify({
        number: 12,
        url: "https://example.test/not-a-github-pr",
        baseRefName: "main",
        headRefName: "branch",
        headRefOid: "def456",
      }),
    );
    const { resolvePullRequest } = await import("../../src/github/resolvePullRequest");

    await expect(resolvePullRequest("/repo", "12")).rejects.toThrow(
      "cannot parse owner/repo from PR url: https://example.test/not-a-github-pr",
    );
  });

  test("listPullRequestFiles returns trimmed changed paths from paginated gh api output", async () => {
    ghResponses.push("\nsrc/index.ts\n\n apps/review/src/github/runGh.ts \n");
    const { listPullRequestFiles } = await import("../../src/github/listPullRequestFiles");

    await expect(listPullRequestFiles("/repo", pr)).resolves.toEqual(
      new Set(["src/index.ts", "apps/review/src/github/runGh.ts"]),
    );
    expect(ghCalls).toEqual([
      {
        repoDir: "/repo",
        args: [
          "api",
          "--paginate",
          "repos/smithersai/smithers/pulls/306/files",
          "--jq",
          ".[].filename",
        ],
      },
    ]);
  });

  test("postPullRequestReview posts the review payload through gh api stdin", async () => {
    const payload: PullRequestReviewPayload = {
      commit_id: "abc123",
      event: "COMMENT",
      body: "Review body",
      comments: [{ path: "src/index.ts", line: 7, side: "RIGHT", body: "Check this." }],
    };
    ghResponses.push(JSON.stringify({ html_url: "https://github.com/smithersai/smithers/pull/306#pullrequestreview-1" }));
    const { postPullRequestReview } = await import("../../src/github/postPullRequestReview");

    await expect(postPullRequestReview("/repo", pr, payload)).resolves.toEqual({
      url: "https://github.com/smithersai/smithers/pull/306#pullrequestreview-1",
      inline: 1,
    });
    expect(ghCalls).toEqual([
      {
        repoDir: "/repo",
        args: ["api", "--method", "POST", "repos/smithersai/smithers/pulls/306/reviews", "--input", "-"],
        stdin: JSON.stringify(payload),
      },
    ]);
  });

  test("postPullRequestReview folds inline comments into the body after an inline batch failure", async () => {
    const payload: PullRequestReviewPayload = {
      commit_id: "abc123",
      event: "COMMENT",
      body: "Review body",
      comments: [
        { path: "src/index.ts", line: 7, side: "RIGHT", body: "Check this." },
        { path: "src/range.ts", start_line: 4, line: 9, side: "RIGHT", body: "Range note." },
      ],
    };
    ghResponses.push(new Error("gh api failed: HTTP 422"), JSON.stringify({}));
    const { postPullRequestReview } = await import("../../src/github/postPullRequestReview");

    await expect(postPullRequestReview("/repo", pr, payload)).resolves.toEqual({
      url: "https://github.com/smithersai/smithers/pull/306",
      inline: 0,
    });

    expect(ghCalls).toHaveLength(2);
    expect(JSON.parse(ghCalls[0].stdin ?? "")).toEqual(payload);
    const fallback = JSON.parse(ghCalls[1].stdin ?? "") as PullRequestReviewPayload;
    expect(fallback.comments).toEqual([]);
    expect(fallback.body).toContain("### Inline findings (could not anchor in the diff)");
    expect(fallback.body).toContain("`src/index.ts:7`");
    expect(fallback.body).toContain("`src/range.ts:4`");
    expect(fallback.body).toContain("Range note.");
  });

  test("postPullRequestReview rethrows failures when there are no inline comments to fold", async () => {
    const payload: PullRequestReviewPayload = {
      commit_id: "abc123",
      event: "COMMENT",
      body: "Review body",
      comments: [],
    };
    ghResponses.push(new Error("gh api failed: HTTP 500"));
    const { postPullRequestReview } = await import("../../src/github/postPullRequestReview");

    await expect(postPullRequestReview("/repo", pr, payload)).rejects.toThrow("gh api failed: HTTP 500");
    expect(ghCalls).toHaveLength(1);
  });
});

import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PullRequestReviewPayload } from "../../src/github/buildPullRequestReview";
import { listPullRequestFiles, type PullRequestFile } from "../../src/github/listPullRequestFiles";
import { postPullRequestReview } from "../../src/github/postPullRequestReview";
import { resolvePullRequest, type PullRequestTarget } from "../../src/github/resolvePullRequest";
import { serializeReviewManifest } from "../../src/reviewManifest";

type GhCall = {
  repoDir: string;
  args: string[];
  stdin?: string;
};

const ghCalls: GhCall[] = [];
const ghResponses: Array<string | Error> = [];

// Injected directly into the helpers (they accept runGh as a parameter). This
// avoids `mock.module`, which is process-global in bun and leaks across test
// files (on Linux it would replace the real runGh for runGh.test.ts).
const runGhMock = mock(async (repoDir: string, args: string[], stdin?: string) => {
  ghCalls.push({ repoDir, args, stdin });
  const response = ghResponses.shift();
  if (response instanceof Error) throw response;
  return response ?? "";
});

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
  headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  title: "Fix the widget",
  body: "Closes #306.",
  state: "open",
  draft: false,
};
const publicationFiles = new Map<string, PullRequestFile>([
  ["src/index.ts", { filename: "src/index.ts", additions: 1, deletions: 0, commentableLines: new Set([7]) }],
  ["src/range.ts", { filename: "src/range.ts", additions: 6, deletions: 0, commentableLines: new Set([4, 5, 6, 7, 8, 9]) }],
  ...["a", "b", "c", "d", "e", "f", "g"].map((name, index): [string, PullRequestFile] => [
    `${name}.ts`,
    { filename: `${name}.ts`, additions: 1, deletions: 0, commentableLines: new Set([index + 1]) },
  ]),
]);
const metadata = JSON.stringify({ state: "open", draft: false, base: { ref: "main", sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, head: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, changed_files: publicationFiles.size });
const publicationOptions = { expectedBaseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", prFiles: publicationFiles };

describe("GitHub PR posting helpers", () => {
  test("resolvePullRequest resolves coordinates from gh pr view JSON", async () => {
    ghResponses.push(
      JSON.stringify({
        number: 306,
        url: "https://github.com/smithersai/smithers/pull/306",
        baseRefName: "main",
        headRefName: "fix-i306-w8",
        headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        title: "Fix the widget",
        body: "Closes #306.",
        state: "OPEN",
        isDraft: false,
      }),
    );

    await expect(resolvePullRequest("/repo", "306", runGhMock)).resolves.toEqual(pr);
    expect(ghCalls).toEqual([
      {
        repoDir: "/repo",
        args: ["pr", "view", "306", "--json", "number,url,baseRefName,headRefName,headRefOid,title,body,state,isDraft"],
      },
    ]);
  });

  test("resolvePullRequest resolves GitHub Enterprise PR URLs by path", async () => {
    ghResponses.push(
      JSON.stringify({
        number: 9,
        url: "https://ghe.example.corp/acme/tools/pull/9",
        baseRefName: "main",
        headRefName: "topic",
        headRefOid: "f".repeat(40),
        state: "OPEN",
        isDraft: false,
      }),
    );

    const resolved = await resolvePullRequest("/repo", "9", runGhMock);
    expect(resolved.owner).toBe("acme");
    expect(resolved.repo).toBe("tools");
    expect(resolved.number).toBe(9);
    expect(resolved.title).toBe("");
    expect(resolved.body).toBe("");
  });

  test("resolvePullRequest rejects PR URLs that cannot identify owner and repo", async () => {
    ghResponses.push(
      JSON.stringify({
        number: 12,
        url: "https://example.test/not-a-github-pr",
        baseRefName: "main",
        headRefName: "branch",
        headRefOid: "d".repeat(40),
        state: "OPEN",
        isDraft: false,
      }),
    );

    await expect(resolvePullRequest("/repo", "12", runGhMock)).rejects.toThrow(
      "cannot parse owner/repo from pull request URL",
    );
  });

  test("listPullRequestFiles reads only the protected manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-files-"));
    const manifest = join(dir, "manifest.jsonl");
    writeFileSync(manifest, serializeReviewManifest([
      { oldPath: "assets/logo.png", newPath: "assets/logo.png", filename: "assets/logo.png", status: "A", additions: 0, deletions: 0, binary: true, newMode: "100644" },
      { oldPath: "src/index.ts", newPath: "src/index.ts", filename: "src/index.ts", status: "M", additions: 2, deletions: 1, binary: false, oldMode: "100644", newMode: "100644", patch: `diff --git a/src/index.ts b/src/index.ts\nindex ${"1".repeat(40)}..${"2".repeat(40)} 100644\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,2 +1,3 @@\n context\n-old\n+new\n+more\n` },
    ]), { mode: 0o444 });
    const files = await listPullRequestFiles("/repo", pr, manifest);
    expect([...files.keys()]).toEqual(["assets/logo.png", "src/index.ts"]);
    expect(files.get("src/index.ts")).toEqual({
      filename: "src/index.ts",
      additions: 2,
      deletions: 1,
      commentableLines: new Set([1, 2, 3]),
    });
    const binary = files.get("assets/logo.png") as PullRequestFile;
    expect(binary.additions).toBe(0);
    expect(binary.deletions).toBe(0);
    expect(binary.commentableLines.size).toBe(0);
    expect(ghCalls).toEqual([]);
  });

  test("postPullRequestReview posts the review payload through gh api stdin", async () => {
    const payload: PullRequestReviewPayload = {
      commit_id: pr.headSha,
      event: "COMMENT",
      body: "<!-- smithers-review -->\nReview body",
      comments: [{ path: "src/index.ts", line: 7, side: "RIGHT", body: "Check this." }],
    };
    ghResponses.push(metadata, JSON.stringify({ html_url: "https://github.com/smithersai/smithers/pull/306#pullrequestreview-1" }));

    await expect(postPullRequestReview("/repo", pr, payload, runGhMock, publicationOptions)).resolves.toEqual({
      url: "https://github.com/smithersai/smithers/pull/306#pullrequestreview-1",
      inline: 1,
      superseded: 0,
    });
    expect(ghCalls).toEqual([
      { repoDir: "/repo", args: ["api", "repos/smithersai/smithers/pulls/306"] },
      {
        repoDir: "/repo",
        args: ["api", "--method", "POST", "repos/smithersai/smithers/pulls/306/reviews", "--input", "-"],
        stdin: JSON.stringify(payload),
      },
    ]);
  });

  test("gh transport removes the GitHub Enterprise API base path before invoking gh", async () => {
    const previous = process.env.GITHUB_API_URL;
    process.env.GITHUB_API_URL = "https://ghe.example.corp/api/v3";
    try {
      const payload: PullRequestReviewPayload = {
        commit_id: pr.headSha,
        event: "COMMENT",
        body: "<!-- smithers-review -->\nReview body",
        comments: [],
      };
      ghResponses.push(metadata, "{}");
      await postPullRequestReview("/repo", pr, payload, runGhMock, publicationOptions);
      expect(ghCalls[0].args).toEqual(["api", "repos/smithersai/smithers/pulls/306"]);
      expect(ghCalls[1].args).toEqual([
        "api", "--method", "POST", "repos/smithersai/smithers/pulls/306/reviews", "--input", "-",
      ]);
    } finally {
      if (previous === undefined) delete process.env.GITHUB_API_URL;
      else process.env.GITHUB_API_URL = previous;
    }
  });

  test("rejects a payload-selected path or line outside protected file capabilities before gh runs", async () => {
    const payload: PullRequestReviewPayload = {
      commit_id: pr.headSha,
      event: "COMMENT",
      body: "<!-- smithers-review -->\nReview body",
      comments: [{ path: "src/index.ts", line: 8, side: "RIGHT", body: "Forged anchor." }],
    };
    await expect(postPullRequestReview("/repo", pr, payload, runGhMock, publicationOptions)).rejects.toThrow(/patch capability/);
    expect(ghCalls).toEqual([]);
  });

  test("supersedes only same-author reviews older than the newly posted review", async () => {
    const payload: PullRequestReviewPayload = {
      commit_id: pr.headSha,
      event: "COMMENT",
      body: "<!-- smithers-review -->\nCurrent review",
      comments: [{ path: "src/index.ts", line: 7, side: "RIGHT", body: "Current finding." }],
    };
    ghResponses.push(
      metadata,
      JSON.stringify({ id: 10, html_url: `${pr.url}#pullrequestreview-10`, user: { login: "smithers-bot" } }),
      JSON.stringify([
        { id: 5, body: "<!-- smithers-review -->\nEarlier", user: { login: "smithers-bot" } },
        { id: 10, body: "<!-- smithers-review -->\nCurrent", user: { login: "smithers-bot" } },
        // A concurrent newer publication must never be superseded by this run.
        { id: 11, body: "<!-- smithers-review -->\nNewer", user: { login: "smithers-bot" } },
        { id: 4, body: "<!-- smithers-review -->\nOther author", user: { login: "human" } },
      ]),
      "{}",
    );

    await expect(postPullRequestReview("/repo", pr, payload, runGhMock, publicationOptions)).resolves.toEqual({
      url: `${pr.url}#pullrequestreview-10`,
      inline: 1,
      reviewId: 10,
      superseded: 1,
    });
    expect(ghCalls).toHaveLength(4);
    expect(ghCalls[2].args).toEqual([
      "api", "repos/smithersai/smithers/pulls/306/reviews?per_page=100&page=1",
    ]);
    expect(ghCalls[3].args).toEqual([
      "api", "--method", "PUT", "repos/smithersai/smithers/pulls/306/reviews/5", "--input", "-",
    ]);
    expect(JSON.parse(ghCalls[3].stdin ?? "").body).toStartWith("Superseded by a newer smithers review.");
  });

  test("postPullRequestReview folds inline comments into the body after an inline batch failure", async () => {
    const payload: PullRequestReviewPayload = {
      commit_id: pr.headSha,
      event: "COMMENT",
      body: "<!-- smithers-review -->\nReview body",
      comments: [
        { path: "src/index.ts", line: 7, side: "RIGHT", body: "Check this." },
        { path: "src/range.ts", start_line: 4, start_side: "RIGHT", line: 9, side: "RIGHT", body: "Range note." },
      ],
    };
    ghResponses.push(metadata, new Error("gh api failed: HTTP 422"), metadata, JSON.stringify({}));

    await expect(postPullRequestReview("/repo", pr, payload, runGhMock, publicationOptions)).resolves.toEqual({
      url: "https://github.com/smithersai/smithers/pull/306",
      inline: 0,
      superseded: 0,
    });

    expect(ghCalls).toHaveLength(4);
    expect(JSON.parse(ghCalls[1].stdin ?? "")).toEqual(payload);
    const fallback = JSON.parse(ghCalls[3].stdin ?? "") as PullRequestReviewPayload;
    expect(fallback.comments).toEqual([]);
    expect(fallback.body).toContain("### Inline findings");
    expect(fallback.body).toContain("`src/index.ts:7`");
    expect(fallback.body).toContain("`src/range.ts:4`");
    expect(fallback.body).toContain("Range note.");
  });

  test("postPullRequestReview folds comments up to the size budget, keeping fences intact", async () => {
    const big = "z".repeat(9_900);
    const payload: PullRequestReviewPayload = {
      commit_id: pr.headSha,
      event: "COMMENT",
      body: "<!-- smithers-review -->\nReview body",
      comments: ["a", "b", "c", "d", "e", "f", "g"].map((name, index) => ({ path: `${name}.ts`, line: index + 1, side: "RIGHT" as const, body: `\`\`\`suggestion\n${big}\n\`\`\`` })),
    };
    ghResponses.push(metadata, new Error("gh api failed: HTTP 422"), metadata, JSON.stringify({}));

    await postPullRequestReview("/repo", pr, payload, runGhMock, publicationOptions);
    const fallback = JSON.parse(ghCalls[3].stdin ?? "") as PullRequestReviewPayload;
    expect(fallback.body.length).toBeLessThanOrEqual(60_000);
    // Later comments are summarized rather than sliced mid-code-fence.
    expect(fallback.body).toContain("`a.ts:1`");
    expect(fallback.body).not.toContain("`g.ts:7`");
    expect(fallback.body).toMatch(/inline finding.*omitted due to review size limits/);
    expect(fallback.body).toContain("```suggestion");
  });

  test("postPullRequestReview rethrows failures when there are no inline comments to fold", async () => {
    const payload: PullRequestReviewPayload = {
      commit_id: pr.headSha,
      event: "COMMENT",
      body: "<!-- smithers-review -->\nReview body",
      comments: [],
    };
    ghResponses.push(metadata, new Error("gh api failed: HTTP 500"));

    await expect(postPullRequestReview("/repo", pr, payload, runGhMock, publicationOptions)).rejects.toThrow("gh api failed: HTTP 500");
    expect(ghCalls).toHaveLength(2);
  });
});

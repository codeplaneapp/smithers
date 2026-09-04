import { afterEach, describe, expect, mock, test } from "bun:test";
import type { PullRequestTarget } from "../../src/github/resolvePullRequest.ts";
import { supersedePriorReviews } from "../../src/github/supersedePriorReviews.ts";

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
  title: "Fix the widget",
  body: "Closes #306.",
};

const MARKER = "<!-- smithers-review -->";

describe("supersedePriorReviews", () => {
  test("updates each prior marker-bearing bot review and returns the count", async () => {
    ghResponses.push(
      "smithers-bot\n",
      [
        JSON.stringify({ id: 1, body: `${MARKER}\nOld review one`, login: "smithers-bot" }),
        // Another user's review with the marker: untouched.
        JSON.stringify({ id: 2, body: `${MARKER}\nSomeone else`, login: "human" }),
        // Bot review without the marker: untouched.
        JSON.stringify({ id: 3, body: "LGTM", login: "smithers-bot" }),
        // Already superseded: untouched.
        JSON.stringify({
          id: 4,
          body: `Superseded by a newer smithers review.\n\n${MARKER}\nAncient`,
          login: "smithers-bot",
        }),
        JSON.stringify({ id: 5, body: `${MARKER}\nOld review two`, login: "smithers-bot" }),
      ].join("\n"),
      "{}",
      "{}",
    );

    await expect(supersedePriorReviews("/repo", pr, runGhMock)).resolves.toBe(2);

    expect(ghCalls).toHaveLength(4);
    expect(ghCalls[0].args).toEqual(["api", "user", "--jq", ".login"]);
    expect(ghCalls[1].args).toEqual([
      "api",
      "--paginate",
      "repos/smithersai/smithers/pulls/306/reviews",
      "--jq",
      ".[] | {id, body, login: .user.login} | @json",
    ]);
    const updateCalls = ghCalls.slice(2);
    expect(updateCalls.map((call) => call.args)).toEqual([
      ["api", "--method", "PUT", "repos/smithersai/smithers/pulls/306/reviews/1", "--input", "-"],
      ["api", "--method", "PUT", "repos/smithersai/smithers/pulls/306/reviews/5", "--input", "-"],
    ]);
    expect(JSON.parse(updateCalls[0].stdin ?? "")).toEqual({
      body: `Superseded by a newer smithers review.\n\n${MARKER}\nOld review one`,
    });
  });

  test("a failing review-list call is non-fatal and returns 0", async () => {
    ghResponses.push("smithers-bot\n", new Error("gh api failed: HTTP 502"));
    await expect(supersedePriorReviews("/repo", pr, runGhMock)).resolves.toBe(0);
    expect(ghCalls).toHaveLength(2);
  });

  test("a failing per-review update is skipped; the rest still count", async () => {
    ghResponses.push(
      "smithers-bot\n",
      [
        JSON.stringify({ id: 7, body: `${MARKER}\nFirst`, login: "smithers-bot" }),
        JSON.stringify({ id: 8, body: `${MARKER}\nSecond`, login: "smithers-bot" }),
      ].join("\n"),
      new Error("gh api failed: HTTP 422"),
      "{}",
    );
    await expect(supersedePriorReviews("/repo", pr, runGhMock)).resolves.toBe(1);
    expect(ghCalls).toHaveLength(4);
  });

  test("an empty gh login short-circuits to 0 without listing reviews", async () => {
    ghResponses.push("\n");
    await expect(supersedePriorReviews("/repo", pr, runGhMock)).resolves.toBe(0);
    expect(ghCalls).toHaveLength(1);
  });
});

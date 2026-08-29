import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { gateEvent } from "../../action/src/gateEvent.ts";

/**
 * What `.github/workflows/pr-review.yml` does with a real GitHub event.
 *
 * The workflow itself cannot be run from here: its first step mints a GitHub
 * OIDC token, which only Actions issues, and its review posts to a pull
 * request. What IS reachable is everything the workflow decides before it
 * spends anything, and this suite drives that against a real `pull_request`
 * event fetched live from GitHub: the gate's own decision, and the workflow
 * file's agreement with the action it calls.
 *
 * Skips with a named reason when the `gh` CLI has no credential.
 */
function ghAvailable(): boolean {
  const bin = process.env.SMITHERS_GH_BIN || "gh";
  if (spawnSync(process.platform === "win32" ? "where" : "which", [bin]).status !== 0) return false;
  if (process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim()) return true;
  return spawnSync(bin, ["auth", "status"]).status === 0;
}

const enabled = ghAvailable();
if (!enabled) {
  console.log("[pr-review e2e] skipped — set GITHUB_TOKEN (or run `gh auth login`) and install the gh CLI");
}

const workflow = parse(
  readFileSync(new URL("../../../../.github/workflows/pr-review.yml", import.meta.url), "utf8"),
) as {
  on: Record<string, { types?: string[] }>;
  permissions: Record<string, string>;
  jobs: Record<string, { steps: Array<{ uses?: string }>; env?: Record<string, string> }>;
};

describe("pr-review.yml", () => {
  test("calls this repository's own action at @main", () => {
    const step = workflow.jobs.review.steps.find((entry) => entry.uses?.includes("apps/review/action"));
    expect(step?.uses).toBe("smithersai/smithers/apps/review/action@main");
  });

  test("asks for exactly the three permissions the action needs", () => {
    expect(workflow.permissions).toEqual({
      "id-token": "write",
      contents: "read",
      "pull-requests": "write",
    });
  });

  test("triggers only on the events the gate reviews", () => {
    // The gate skips every other pull_request action with a reason, so a
    // trigger the gate does not review is a job that starts and does nothing.
    expect(new Set(workflow.on.pull_request.types)).toEqual(
      new Set(["opened", "synchronize", "reopened", "ready_for_review"]),
    );
    expect(workflow.on.issue_comment.types).toEqual(["created"]);
  });

  test("carries no 0.x subscription secret", () => {
    const env = workflow.jobs.review.env ?? {};
    expect(env.CODEX_AUTH_JSON).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("${{ secrets.ANTHROPIC_API_KEY }}");
  });
});

describe.skipIf(!enabled)("the gate against a live GitHub pull request", () => {
  const target = process.env.SMITHERS_REVIEW_E2E_PR?.trim() || "https://github.com/cli/cli/pull/9000";
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(target);
  const slug = match ? `${match[1]}/${match[2]}` : target.split("#")[0];
  const number = match ? Number(match[3]) : Number(target.split("#")[1]);

  /** The `pull_request` payload GitHub would hand the workflow, from the API. */
  function livePullRequest(): Record<string, unknown> {
    const raw = execFileSync("gh", ["api", `repos/${slug}/pulls/${number}`], { encoding: "utf8", env: process.env });
    return JSON.parse(raw) as Record<string, unknown>;
  }

  test("reviews a real same-repo pull request and reports its number", () => {
    const pr = livePullRequest();
    const decision = gateEvent({
      eventName: "pull_request",
      payload: { action: "synchronize", pull_request: pr },
    });
    expect(decision.run).toBe(true);
    if (decision.run) {
      expect(decision.prNumber).toBe(number);
      expect(decision.headSha).toMatch(/^[0-9a-f]{40}$/);
    }
  }, 120_000);

  test("skips the same real pull request when the action does not change the diff", () => {
    const decision = gateEvent({ eventName: "pull_request", payload: { action: "labeled", pull_request: livePullRequest() } });
    expect(decision.run).toBe(false);
    if (!decision.run) expect(decision.reason).toContain("labeled");
  }, 120_000);

  test("the gate step writes the outputs the workflow's later steps read", () => {
    // The real composite step, spawned the way action.yml spawns it.
    const dir = mkdtempSync(join(tmpdir(), "pr-review-gate-"));
    try {
      const eventPath = join(dir, "event.json");
      const outputPath = join(dir, "output");
      const pr = livePullRequest();
      writeFileSync(eventPath, JSON.stringify({ action: "synchronize", pull_request: pr }));
      writeFileSync(outputPath, "");
      const gate = fileURLToPath(new URL("../../action/src/runGate.ts", import.meta.url));
      const result = spawnSync("bun", [gate], {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: outputPath,
        },
      });
      expect(result.status).toBe(0);
      const written = readFileSync(outputPath, "utf8");
      expect(written).toContain("should-run=true");
      expect(written).toContain(`pr-number=${number}`);
      expect(written).toContain(`head-sha=${(pr.head as { sha: string }).sha}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

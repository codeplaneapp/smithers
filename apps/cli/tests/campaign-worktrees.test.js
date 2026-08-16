import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listUnownedCampaignWorktrees, reapUnownedCampaignWorktrees } from "../src/campaignWorktrees.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-campaign-worktrees-")));
let sequence = 0;
let repo;

afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

beforeEach(() => {
  repo = join(root, `repo-${sequence++}`);
  git(root, ["init", "-b", "main", repo]);
  git(repo, ["config", "user.email", "test@smithers.sh"]);
  git(repo, ["config", "user.name", "smithers-test"]);
  writeFileSync(join(repo, "file.txt"), "hello\n");
  git(repo, ["add", "file.txt"]);
  git(repo, ["commit", "-m", "init"]);
});

function createCampaignWorktree(name = "lane-a") {
  const path = join(repo, ".smithers", "workflows", ".worktrees", name);
  git(repo, ["worktree", "add", "-b", `campaign/${name}`, path, "main"]);
  return path;
}

describe("unowned campaign worktrees", () => {
  test("surfaces hidden registered worktrees without treating arbitrary human worktrees as Smithers-owned", async () => {
    const campaign = createCampaignWorktree();
    const manual = join(root, `manual-${sequence++}`);
    git(repo, ["worktree", "add", "-b", "human/manual", manual, "main"]);

    const rows = await listUnownedCampaignWorktrees(repo);

    expect(rows.map((entry) => entry.path)).toEqual([campaign]);
    expect(rows[0].branch).toBe("refs/heads/campaign/lane-a");
    expect(rows.some((entry) => entry.path === manual)).toBe(false);
  });

  test("requires explicit opt-in and retains a lane used by a live process", async () => {
    const campaign = createCampaignWorktree();
    const oldMs = Date.now() - 8 * 24 * 60 * 60 * 1_000;
    utimesSync(campaign, new Date(oldMs), new Date(oldMs));

    const inventory = await reapUnownedCampaignWorktrees({
      rootDir: repo,
      olderThanMs: 7 * 24 * 60 * 60 * 1_000,
      liveCwds: [],
      sizeOf: async () => 100,
    });
    expect(inventory.skipped[0].reason).toBe("requires-include-unmanaged");

    const live = await reapUnownedCampaignWorktrees({
      rootDir: repo,
      includeUnmanaged: true,
      olderThanMs: 7 * 24 * 60 * 60 * 1_000,
      liveCwds: [join(campaign, "nested")],
      sizeOf: async () => 100,
    });
    expect(live.skipped[0].reason).toBe("live-process");
    expect(existsSync(campaign)).toBe(true);
  });

  test("removes an old clean lane whose HEAD is already upstream", async () => {
    const campaign = createCampaignWorktree();
    const oldMs = Date.now() - 8 * 24 * 60 * 60 * 1_000;
    utimesSync(campaign, new Date(oldMs), new Date(oldMs));

    const result = await reapUnownedCampaignWorktrees({
      rootDir: repo,
      includeUnmanaged: true,
      olderThanMs: 7 * 24 * 60 * 60 * 1_000,
      liveCwds: [],
      sizeOf: async () => 100,
    });

    expect(result.removed).toHaveLength(1);
    expect(result.bytesFreed).toBe(100);
    expect(existsSync(campaign)).toBe(false);
    expect(git(repo, ["worktree", "list"])).not.toContain(campaign);
  });

  test("never removes unpublished work from an unowned lane", async () => {
    const campaign = createCampaignWorktree();
    writeFileSync(join(campaign, "unpublished.txt"), "keep\n");

    const result = await reapUnownedCampaignWorktrees({
      rootDir: repo,
      includeUnmanaged: true,
      olderThanMs: 0,
      nowMs: Date.now() + 1_000,
      liveCwds: [],
      sizeOf: async () => 100,
    });

    expect(result.skipped[0].reason).toBe("unpublished-work");
    expect(existsSync(join(campaign, "unpublished.txt"))).toBe(true);
  });

  test("surfaces but never guesses how to remove an unowned jj workspace", async () => {
    const campaign = createCampaignWorktree();
    mkdirSync(join(campaign, ".jj"));

    const result = await reapUnownedCampaignWorktrees({
      rootDir: repo,
      includeUnmanaged: true,
      olderThanMs: 0,
      nowMs: Date.now() + 1_000,
      liveCwds: [],
      sizeOf: async () => 100,
    });

    expect(result.skipped[0].reason).toBe("unowned-jj-workspace");
    expect(existsSync(campaign)).toBe(true);
  });

  test("keeps a clean multi-commit lane when only some patches landed", async () => {
    const campaign = createCampaignWorktree();
    writeFileSync(join(campaign, "one.txt"), "one\n");
    git(campaign, ["add", "one.txt"]);
    git(campaign, ["commit", "-m", "one"]);
    const first = git(campaign, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(campaign, "two.txt"), "two\n");
    git(campaign, ["add", "two.txt"]);
    git(campaign, ["commit", "-m", "two"]);
    git(repo, ["cherry-pick", first]);

    const result = await reapUnownedCampaignWorktrees({
      rootDir: repo,
      includeUnmanaged: true,
      olderThanMs: 0,
      nowMs: Date.now() + 1_000,
      liveCwds: [],
      sizeOf: async () => 100,
    });

    expect(result.skipped[0].reason).toBe("unpublished-work");
    expect(existsSync(campaign)).toBe(true);
  });
});

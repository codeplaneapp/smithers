// smithers-source: authored
// smithers-display-name: jjhub Issue Fleet
// smithers-description: One jjhub sandbox per open smithersai/plue issue; codex sol implements in-VM; branches land as GitHub PRs + jjhub landing requests.
/** @jsxImportSource smithers-orchestrator */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSmithers, UI } from "smithers-orchestrator";
import { z } from "zod/v4";

/**
 * jjhub Issue Fleet — kills two birds with one stone:
 *  1. Exercises jjhub (plue / Smithers Cloud) end to end in prod: bookmarks,
 *     per-branch Microsandbox workspaces, in-VM agent work, jj pushes back to
 *     the forge, and landing requests.
 *  2. Produces one GitHub PR per open smithersai/plue issue, implemented by
 *     codex gpt-5.6-sol running INSIDE the jjhub workspace VM for that branch.
 *
 * Per-issue lane: bookmark issue-N → workspace(source_bookmark=issue-N) →
 * install codex binary + seed auth in-VM → codex sol implements → jj push
 * bookmark → local: replay diff onto GitHub base → gh pr create → jjhub
 * landing request → delete workspace.
 *
 * VM constraints (prod runner image, discovered empirically): 512MB RAM /
 * 1 vCPU; HOME=/workspace is root-owned so every remote command exports
 * HOME=/home/developer plus XDG/BUN overrides; the exec transport rejects
 * multi-line commands, so remote payloads travel base64-encoded.
 */

const JJHUB_API = "https://api.jjhub.tech/api";
const inputSchema = z.object({
  /** GitHub issue numbers to fix. Empty = every open issue in the repo. */
  issues: z.array(z.number().int()).default([]),
  /** Concurrent lanes (each lane = one live Microsandbox VM + one sol run). */
  laneConcurrency: z.number().int().min(1).max(8).default(4),
  /** jjhub repo (owner/name) that mirrors the GitHub repo at baseSha. */
  jjhubRepo: z.string().default("smithers-canary/plue"),
  /** GitHub repo (owner/name) the PRs target. */
  githubRepo: z.string().default("smithersai/plue"),
  /** GitHub commit the jjhub snapshot mirrors; PR branches fork from here. */
  baseSha: z.string().default("b565d53aed941ec383fd8e33678e95055aaec1dd"),
  /** git commit id of the snapshot root on jjhub (diff base for lanes). */
  jjhubBaseCommit: z.string().default("963ec6da91820ce8b09906624d7f681cb3d6f498"),
  /** Path to the plue/jjhub CLI binary. */
  plueBin: z.string().default("/Users/williamcory/plue/bin/smithers"),
  /** Skip cleanup (keep workspaces alive for debugging). */
  keepWorkspaces: z.boolean().default(false),
});

const issueRowSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()),
});
const discoverySchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  issues: z.array(issueRowSchema).default([]),
  mainChangeId: z.string().optional(),
  baseRepoDir: z.string().optional(),
});
const sandboxSchema = z.object({
  issue: z.number(),
  ok: z.boolean(),
  workspaceId: z.string().optional(),
  bookmark: z.string(),
  error: z.string().optional(),
});
const implementSchema = z.object({
  issue: z.number(),
  ok: z.boolean(),
  pushed: z.boolean().default(false),
  tipChangeId: z.string().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
});
const prSchema = z.object({
  issue: z.number(),
  ok: z.boolean(),
  prUrl: z.string().optional(),
  landingNumber: z.number().optional(),
  branch: z.string().optional(),
  error: z.string().optional(),
});
const cleanupSchema = z.object({ issue: z.number(), ok: z.boolean(), error: z.string().optional() });
const summarySchema = z.object({
  prs: z.array(z.object({ issue: z.number(), prUrl: z.string() })),
  landings: z.array(z.object({ issue: z.number(), landingNumber: z.number() })),
  failed: z.array(z.object({ issue: z.number(), stage: z.string(), error: z.string() })),
});

const { Workflow, Task, Sequence, Parallel, smithers, outputs } = createSmithers({
  input: inputSchema,
  discovery: discoverySchema,
  sandbox: sandboxSchema,
  implement: implementSchema,
  pr: prSchema,
  cleanup: cleanupSchema,
  summary: summarySchema,
});

// ── Local plumbing ───────────────────────────────────────────────────────────

const FLEET_HOME = join(homedir(), ".smithers-scratch", "jjhub-fleet");
const CLI_CONFIG_HOME = join(FLEET_HOME, "xdg-config");
let cachedToken: string | undefined;

function jjhubToken(): string {
  if (!cachedToken) {
    cachedToken = execFileSync(
      "gcloud",
      ["secrets", "versions", "access", "latest", "--secret", "multi-canary-plue-token"],
      { encoding: "utf8" },
    ).trim();
  }
  return cachedToken;
}

async function jjhubApi(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${JJHUB_API}${path}`, {
    method: init?.method ?? "GET",
    headers: { Authorization: `token ${jjhubToken()}`, "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: response.status, json };
}

function ensureCliConfig(): void {
  const dir = join(CLI_CONFIG_HOME, "plue");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.yml"), 'api_url: "https://api.jjhub.tech"\ngit_protocol: ssh\n');
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, ...opts.env },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as any).code === "number" ? (error as any).code : 1) : 0;
        resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** Run a single-line command inside a jjhub workspace VM via the plue CLI. */
async function wsExec(
  ctx: { plueBin: string; jjhubRepo: string },
  workspaceId: string,
  command: string,
  timeoutSec: number,
): Promise<{ code: number; out: string }> {
  ensureCliConfig();
  const result = await run(
    ctx.plueBin,
    ["workspace", "exec", workspaceId, "--repo", ctx.jjhubRepo, "--command", command, "--timeout", String(timeoutSec)],
    {
      timeoutMs: (timeoutSec + 90) * 1000,
      env: { XDG_CONFIG_HOME: CLI_CONFIG_HOME, SMITHERS_TOKEN: jjhubToken() },
    },
  );
  return { code: result.code, out: `${result.stdout}\n${result.stderr}`.trim() };
}

/** Env prefix fixing the root-owned /workspace HOME baked into the runner image. */
const VM_ENV =
  "export HOME=/home/developer XDG_CONFIG_HOME=/home/developer/.config XDG_CACHE_HOME=/home/developer/.cache XDG_DATA_HOME=/home/developer/.local/share BUN_INSTALL=/home/developer/.bun BUN_INSTALL_CACHE_DIR=/home/developer/.cache/bun BUN_TMPDIR=/tmp PATH=/home/developer/bin:$PATH";
const CODEX_URL = "https://github.com/openai/codex/releases/latest/download/codex-x86_64-unknown-linux-musl.tar.gz";

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function bookmarkFor(issue: number): string {
  return `issue-${issue}`;
}

function latestRow<T extends { issue: number }>(rows: T[] | undefined, issue: number): T | undefined {
  if (!rows) return undefined;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]?.issue === issue) return rows[i];
  }
  return undefined;
}

// ── Lane steps ───────────────────────────────────────────────────────────────

async function discover(input: z.infer<typeof inputSchema>): Promise<z.infer<typeof discoverySchema>> {
  try {
    const [owner, name] = input.githubRepo.split("/");
    const listed = await run(
      "gh",
      [
        "issue",
        "list",
        "--repo",
        input.githubRepo,
        "--state",
        "open",
        "--limit",
        "200",
        "--json",
        "number,title,body,labels",
      ],
      { timeoutMs: 60_000 },
    );
    if (listed.code !== 0)
      return { ok: false, error: `gh issue list failed: ${truncate(listed.stderr, 400)}`, issues: [] };
    const all = JSON.parse(listed.stdout) as Array<{
      number: number;
      title: string;
      body: string;
      labels: Array<{ name: string }>;
    }>;
    const wanted = input.issues.length > 0 ? all.filter((issue) => input.issues.includes(issue.number)) : all;
    const issues = wanted.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      labels: (issue.labels ?? []).map((label) => label.name),
    }));

    const bookmarks = await jjhubApi(`/repos/${input.jjhubRepo}/bookmarks?limit=100`);
    const main = (bookmarks.json?.items ?? []).find((bookmark: any) => bookmark.name === "main");
    if (!main?.target_change_id)
      return {
        ok: false,
        error: `jjhub ${input.jjhubRepo} has no main bookmark (status ${bookmarks.status})`,
        issues: [],
      };

    // Local base clone of the GitHub repo: PR branches are built here.
    const baseRepoDir = join(FLEET_HOME, "base", `${owner}-${name}`);
    if (!existsSync(join(baseRepoDir, ".git"))) {
      mkdirSync(baseRepoDir, { recursive: true });
      const cloned = await run("git", ["clone", "--quiet", `git@github.com:${input.githubRepo}.git`, baseRepoDir], {
        timeoutMs: 600_000,
      });
      if (cloned.code !== 0)
        return { ok: false, error: `base clone failed: ${truncate(cloned.stderr, 400)}`, issues: [] };
    }
    await run("git", ["fetch", "--quiet", "origin", input.baseSha], { cwd: baseRepoDir, timeoutMs: 300_000 });
    // Prime jjhub objects (snapshot root) so per-lane fetches are deltas.
    const primed = await run(
      "git",
      [
        "-c",
        `http.extraHeader=Authorization: Bearer ${jjhubToken()}`,
        "fetch",
        "--quiet",
        `https://api.jjhub.tech/${input.jjhubRepo}.git`,
        "main",
      ],
      { cwd: baseRepoDir, timeoutMs: 300_000 },
    );
    if (primed.code !== 0)
      return { ok: false, error: `jjhub prime fetch failed: ${truncate(primed.stderr, 400)}`, issues: [] };
    return { ok: true, issues, mainChangeId: main.target_change_id, baseRepoDir };
  } catch (error) {
    return { ok: false, error: truncate(String(error), 500), issues: [] };
  }
}

async function provisionSandbox(
  input: z.infer<typeof inputSchema>,
  issue: number,
  mainChangeId: string,
): Promise<z.infer<typeof sandboxSchema>> {
  const bookmark = bookmarkFor(issue);
  try {
    const created = await jjhubApi(`/repos/${input.jjhubRepo}/bookmarks`, {
      method: "POST",
      body: { name: bookmark, target_change_id: mainChangeId },
    });
    if (created.status >= 400 && created.status !== 409 && created.status !== 422) {
      return {
        issue,
        ok: false,
        bookmark,
        error: `bookmark create ${created.status}: ${truncate(JSON.stringify(created.json), 300)}`,
      };
    }
    // The Microsandbox worker pool is small (single-digit concurrent VMs) and
    // returns 503 no_capacity under load; each provisioning attempt that ends
    // in status "failed" is retried after a backoff so lanes self-pace as
    // capacity frees up. The failed workspace row is deleted before retrying —
    // `workspace create` would otherwise hand the dead row back.
    let workspaceId: string | undefined;
    let lastError = "";
    attempts: for (let attempt = 0; attempt < 6; attempt += 1) {
      if (attempt > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, 120_000));
      const workspace = await jjhubApi(`/repos/${input.jjhubRepo}/workspaces`, {
        method: "POST",
        body: { name: bookmark, source_bookmark: bookmark },
      });
      workspaceId = workspace.json?.id;
      if (!workspaceId) {
        lastError = `workspace create ${workspace.status}: ${truncate(JSON.stringify(workspace.json), 300)}`;
        continue;
      }
      const deadline = Date.now() + 10 * 60_000;
      let status = String(workspace.json?.status ?? "starting");
      while (status !== "running") {
        if (status === "failed" || status === "suspended") {
          lastError = `workspace provisioning ${status} (likely no_capacity)`;
          await jjhubApi(`/repos/${input.jjhubRepo}/workspaces/${workspaceId}`, { method: "DELETE" });
          workspaceId = undefined;
          continue attempts;
        }
        if (Date.now() > deadline) {
          lastError = `workspace stuck in ${status} after 10m`;
          await jjhubApi(`/repos/${input.jjhubRepo}/workspaces/${workspaceId}`, { method: "DELETE" });
          workspaceId = undefined;
          continue attempts;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5000));
        const polled = await jjhubApi(`/repos/${input.jjhubRepo}/workspaces/${workspaceId}`);
        status = String(polled.json?.status ?? status);
      }
      break;
    }
    if (!workspaceId)
      return { issue, ok: false, bookmark, error: lastError || "workspace provisioning failed after retries" };

    const authB64 = b64(readFileSync(join(homedir(), ".codex", "auth.json"), "utf8"));
    // Everything the run needs lives under /home/developer/.fleet (overlay
    // DISK). /tmp is RAM-backed tmpfs on a 512MB VM — parking the 113MB codex
    // tarball or a growing run log there starves codex and gets the whole
    // detached process group OOM-killed mid-run.
    const bootstrap = [
      VM_ENV,
      "mkdir -p /home/developer/bin /home/developer/.codex /home/developer/.config /home/developer/.fleet",
      `curl -fsSL -o /home/developer/.fleet/codex.tgz ${CODEX_URL}`,
      "tar -xzf /home/developer/.fleet/codex.tgz -C /home/developer/bin",
      "rm -f /home/developer/.fleet/codex.tgz",
      "(mv /home/developer/bin/codex-x86_64-unknown-linux-musl /home/developer/bin/codex 2>/dev/null || true)",
      "chmod +x /home/developer/bin/codex",
      `echo ${authB64} | base64 -d > /home/developer/.codex/auth.json`,
      "chmod 600 /home/developer/.codex/auth.json",
      `git config --global 'http.https://api.jjhub.tech.extraHeader' 'Authorization: Bearer ${jjhubToken()}'`,
      "jj config set --user user.name smithers-fleet",
      "jj config set --user user.email will@tevm.tech",
      "/home/developer/bin/codex --version",
      "echo LANE-BOOTSTRAP-OK",
    ].join(" && ");
    const booted = await wsExec(input, workspaceId, bootstrap, 300);
    if (!booted.out.includes("LANE-BOOTSTRAP-OK")) {
      return { issue, ok: false, workspaceId, bookmark, error: `bootstrap failed: ${truncate(booted.out, 400)}` };
    }
    return { issue, ok: true, workspaceId, bookmark };
  } catch (error) {
    return { issue, ok: false, bookmark, error: truncate(String(error), 500) };
  }
}

function solPrompt(issue: z.infer<typeof issueRowSchema>, bookmark: string): string {
  return [
    `Fix GitHub issue #${issue.number} of smithersai/plue (jjhub / Smithers Cloud, a jj-native forge: Go API in cmd/+internal/, sqlc DB layer in db/, Helm/Terraform in infra/, TS apps in apps/).`,
    "",
    `# Issue #${issue.number}: ${issue.title}`,
    `Labels: ${issue.labels.join(", ") || "(none)"}`,
    "",
    issue.body,
    "",
    "# Ground rules",
    "- You are inside a 512MB / 1-vCPU VM. NEVER run full builds or test suites (`go build ./...`, `go test ./...`, `zig build` will OOM). At most `gofmt`, `go vet ./internal/<one-package>/...`, or a single-package `go test -run` if quick. Correctness is enforced later by CI on the PR.",
    "- The repo is a jj (jujutsu) checkout at /home/developer/workspace. Edit files normally; do NOT run git mutation commands.",
    "- Implement the real root-cause fix with tests where the change is testable. If the issue is a large epic or infra program, implement the highest-value concrete slice (code, config, or runbook-quality docs under docs/) that genuinely advances it — never placeholder stubs — and say clearly in your final message what slice you chose and what remains.",
    "- Follow existing code style. Handlers stay thin (routes → services → DB). If you change db/queries or schema, note that `zig build sqlc` must be re-run by CI/maintainer (do not attempt it here).",
    `- When done: run \`jj describe -m "<conventional one-line summary> (#${issue.number})"\` to title the change. Do not push; the harness pushes bookmark ${bookmark} afterwards.`,
    "- Your final message must be a short PR-body-ready summary: what was broken, what you changed, how it was verified, and any follow-ups.",
  ].join("\n");
}

async function implement(
  input: z.infer<typeof inputSchema>,
  issue: z.infer<typeof issueRowSchema>,
  workspaceId: string,
): Promise<z.infer<typeof implementSchema>> {
  const bookmark = bookmarkFor(issue.number);
  try {
    const promptB64 = b64(solPrompt(issue, bookmark));
    const F = "/home/developer/.fleet";
    // The SSH tier kills quiet sessions at ~10 minutes (pack-timeout-derived
    // idle deadline), so a single long exec cannot host a sol run. Start codex
    // DETACHED (survives the SSH session) and poll with fresh short sessions.
    // The exit code is written atomically (tmp+mv) and the runner records its
    // pid so polls can distinguish "still working" from "OOM-killed mid-run"
    // (a 0-byte exit file, seen when the whole process group is killed).
    const startCmd = `${VM_ENV} && echo ${promptB64} | base64 -d > ${F}/prompt.md && rm -f ${F}/codex-exit ${F}/last-message.md ${F}/codex-run.log && cd /home/developer/workspace && (setsid nohup sh -c 'echo $$ > ${F}/codex-pid; timeout 2700 /home/developer/bin/codex exec -m gpt-5.6-sol --dangerously-bypass-approvals-and-sandbox --output-last-message ${F}/last-message.md "$(cat ${F}/prompt.md)" > ${F}/codex-run.log 2>&1; rc=$?; printf %s $rc > ${F}/codex-exit.tmp && mv ${F}/codex-exit.tmp ${F}/codex-exit' >/dev/null 2>&1 &) && echo SOL-STARTED`;
    const started = await wsExec(input, workspaceId, startCmd, 120);
    if (!started.out.includes("SOL-STARTED")) {
      return {
        issue: issue.number,
        ok: false,
        pushed: false,
        error: `sol start failed: ${truncate(started.out, 500)}`,
      };
    }
    const pollCmd = `if test -s ${F}/codex-exit; then echo SOL-DONE=$(cat ${F}/codex-exit); elif test -d /proc/$(cat ${F}/codex-pid 2>/dev/null || echo 0); then echo SOL-RUNNING; else echo SOL-CRASHED; tail -c 400 ${F}/codex-run.log 2>/dev/null; fi`;
    const solDeadline = Date.now() + 50 * 60_000;
    let solExit: string | undefined;
    let lastTail = "";
    let crashed = false;
    while (Date.now() < solDeadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 60_000));
      const polled = await wsExec(input, workspaceId, pollCmd, 90);
      lastTail = polled.out;
      const done = polled.out.match(/SOL-DONE=(\d+)/);
      if (done) {
        solExit = done[1];
        break;
      }
      if (polled.out.includes("SOL-CRASHED")) {
        crashed = true;
        break;
      }
      // Transient poll/SSH failures are tolerated; only the deadline ends the loop.
    }
    if (crashed || solExit === undefined) {
      const reason = crashed ? "sol process died (likely OOM)" : "sol did not finish within 50m";
      return {
        issue: issue.number,
        ok: false,
        pushed: false,
        error: `${reason}; last poll: ${truncate(lastTail, 500)}`,
      };
    }
    if (solExit !== "0") {
      // Salvage a crash-after-completion: codex wrote its final message but
      // died on shutdown. Anything else fails the lane with the log tail.
      const diagnostic = await wsExec(
        input,
        workspaceId,
        `${VM_ENV} && (test -s ${F}/last-message.md && echo FINISHED); tail -c 1200 ${F}/codex-run.log`,
        60,
      );
      if (!diagnostic.out.includes("FINISHED")) {
        return {
          issue: issue.number,
          ok: false,
          pushed: false,
          error: `sol exited ${solExit}: ${truncate(diagnostic.out, 900)}`,
        };
      }
    }

    const finalize = [
      VM_ENV,
      "cd /home/developer/workspace",
      `jj diff --from ${bookmark} --to @ --stat | tail -1`,
      `sh -c 'if jj log -r @ --no-graph -T description | grep -q .; then true; else jj describe -m "fix: ${issue.title.replace(/[^a-zA-Z0-9 .,:#()\/_-]/g, " ")} (#${issue.number})"; fi'`,
      `jj bookmark set ${bookmark} -r @`,
      `jj git push --bookmark ${bookmark}`,
      "echo PUSH-OK",
      "(cat /home/developer/.fleet/last-message.md 2>/dev/null || true)",
    ].join(" && ");
    const pushed = await wsExec(input, workspaceId, finalize, 300);
    if (!pushed.out.includes("PUSH-OK")) {
      return {
        issue: issue.number,
        ok: false,
        pushed: false,
        error: `finalize/push failed: ${truncate(pushed.out, 600)}`,
      };
    }
    const summary = truncate(pushed.out.split("PUSH-OK").pop()?.trim() ?? "", 4000);
    const bookmarks = await jjhubApi(`/repos/${input.jjhubRepo}/bookmarks?limit=100`);
    const row = (bookmarks.json?.items ?? []).find((entry: any) => entry.name === bookmark);
    return { issue: issue.number, ok: true, pushed: true, tipChangeId: row?.target_change_id, summary };
  } catch (error) {
    return { issue: issue.number, ok: false, pushed: false, error: truncate(String(error), 500) };
  }
}

async function openPr(
  input: z.infer<typeof inputSchema>,
  issue: z.infer<typeof issueRowSchema>,
  discovery: z.infer<typeof discoverySchema>,
  impl: z.infer<typeof implementSchema>,
): Promise<z.infer<typeof prSchema>> {
  const bookmark = bookmarkFor(issue.number);
  const branch = `jjhub/${bookmark}`;
  const baseRepoDir = discovery.baseRepoDir!;
  const worktreeDir = join(FLEET_HOME, "worktrees", bookmark);
  try {
    // Fetch into a per-bookmark ref, NEVER FETCH_HEAD: concurrent lanes share
    // this repo and FETCH_HEAD is a single file — racing on it grafted one
    // lane's diff onto a sibling's PR branch in the first full-fleet run.
    const laneRef = `refs/fleet/${bookmark}`;
    const fetched = await run(
      "git",
      [
        "-c",
        `http.extraHeader=Authorization: Bearer ${jjhubToken()}`,
        "fetch",
        "--quiet",
        `https://api.jjhub.tech/${input.jjhubRepo}.git`,
        `+refs/heads/${bookmark}:${laneRef}`,
      ],
      { cwd: baseRepoDir, timeoutMs: 300_000 },
    );
    if (fetched.code !== 0)
      return { issue: issue.number, ok: false, branch, error: `jjhub fetch failed: ${truncate(fetched.stderr, 300)}` };
    const diff = await run("git", ["diff", "--binary", input.jjhubBaseCommit, laneRef], {
      cwd: baseRepoDir,
      timeoutMs: 120_000,
    });
    if (diff.code !== 0 || !diff.stdout.trim())
      return { issue: issue.number, ok: false, branch, error: "empty diff from jjhub bookmark — nothing to PR" };
    const patchPath = join(FLEET_HOME, "worktrees", `${bookmark}.patch`);
    mkdirSync(join(FLEET_HOME, "worktrees"), { recursive: true });
    writeFileSync(patchPath, diff.stdout);

    rmSync(worktreeDir, { recursive: true, force: true });
    await run("git", ["worktree", "prune"], { cwd: baseRepoDir });
    const added = await run("git", ["worktree", "add", "--detach", worktreeDir, input.baseSha], {
      cwd: baseRepoDir,
      timeoutMs: 300_000,
    });
    if (added.code !== 0)
      return { issue: issue.number, ok: false, branch, error: `worktree add failed: ${truncate(added.stderr, 300)}` };
    const applied = await run("git", ["apply", "--index", patchPath], { cwd: worktreeDir, timeoutMs: 120_000 });
    if (applied.code !== 0)
      return { issue: issue.number, ok: false, branch, error: `patch apply failed: ${truncate(applied.stderr, 400)}` };
    const message = `fix: ${issue.title} (#${issue.number})\n\nImplemented by codex gpt-5.6-sol inside a jjhub sandbox (repo ${input.jjhubRepo}, bookmark ${bookmark}).`;
    const committed = await run(
      "git",
      ["-c", "user.name=smithers-fleet", "-c", "user.email=will@tevm.tech", "commit", "--quiet", "-m", message],
      { cwd: worktreeDir, timeoutMs: 60_000 },
    );
    if (committed.code !== 0)
      return { issue: issue.number, ok: false, branch, error: `commit failed: ${truncate(committed.stderr, 300)}` };
    const pushedUp = await run("git", ["push", "--force", "--quiet", "origin", `HEAD:refs/heads/${branch}`], {
      cwd: worktreeDir,
      timeoutMs: 300_000,
    });
    if (pushedUp.code !== 0)
      return { issue: issue.number, ok: false, branch, error: `github push failed: ${truncate(pushedUp.stderr, 300)}` };

    const body = [
      `Closes #${issue.number}.`,
      "",
      impl.summary || "(no summary reported)",
      "",
      "---",
      `Implemented by **codex gpt-5.6-sol** running inside a **jjhub** sandbox (Microsandbox VM) on \`${input.jjhubRepo}\`, bookmark \`${bookmark}\` — part of the jjhub issue-fleet dogfood run.`,
      "",
      "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
    ].join("\n");
    let prUrl: string | undefined;
    const existing = await run(
      "gh",
      ["pr", "view", branch, "--repo", input.githubRepo, "--json", "url", "-q", ".url"],
      { timeoutMs: 60_000 },
    );
    if (existing.code === 0 && existing.stdout.trim().startsWith("http")) {
      prUrl = existing.stdout.trim();
    } else {
      const created = await run(
        "gh",
        [
          "pr",
          "create",
          "--repo",
          input.githubRepo,
          "--head",
          branch,
          "--base",
          "main",
          "--title",
          `fix: ${issue.title} (#${issue.number})`,
          "--body",
          body,
        ],
        { timeoutMs: 120_000 },
      );
      if (created.code !== 0)
        return {
          issue: issue.number,
          ok: false,
          branch,
          error: `gh pr create failed: ${truncate(created.stderr, 400)}`,
        };
      prUrl = created.stdout.trim().split("\n").pop();
    }

    let landingNumber: number | undefined;
    if (impl.tipChangeId) {
      const landing = await jjhubApi(`/repos/${input.jjhubRepo}/landings`, {
        method: "POST",
        body: {
          title: `fix: ${issue.title} (#${issue.number})`,
          body: `Mirror of ${prUrl}`,
          target_bookmark: "main",
          source_bookmark: bookmark,
          change_ids: [impl.tipChangeId],
        },
      });
      landingNumber = landing.json?.number;
    }
    rmSync(worktreeDir, { recursive: true, force: true });
    await run("git", ["worktree", "prune"], { cwd: baseRepoDir });
    return { issue: issue.number, ok: true, prUrl, landingNumber, branch };
  } catch (error) {
    return { issue: issue.number, ok: false, branch, error: truncate(String(error), 500) };
  }
}

async function cleanup(
  input: z.infer<typeof inputSchema>,
  issue: number,
  workspaceId: string | undefined,
): Promise<z.infer<typeof cleanupSchema>> {
  if (!workspaceId || input.keepWorkspaces) return { issue, ok: true };
  try {
    const deleted = await jjhubApi(`/repos/${input.jjhubRepo}/workspaces/${workspaceId}`, { method: "DELETE" });
    return {
      issue,
      ok: deleted.status < 400 || deleted.status === 404,
      error: deleted.status >= 400 && deleted.status !== 404 ? `delete ${deleted.status}` : undefined,
    };
  } catch (error) {
    return { issue, ok: false, error: truncate(String(error), 300) };
  }
}

/**
 * One lane = one concurrency slot = at most one live VM. Provision, bootstrap,
 * sol, push, and delete happen inside a single task so a lane never holds a
 * Microsandbox VM while queued behind another lane's slow stage (that idle-VM
 * pile-up is what exhausted the worker pool on the first full-fleet attempt).
 */
async function laneWork(
  input: z.infer<typeof inputSchema>,
  issue: z.infer<typeof issueRowSchema>,
  mainChangeId: string,
): Promise<z.infer<typeof implementSchema>> {
  const sandbox = await provisionSandbox(input, issue.number, mainChangeId);
  if (!sandbox.ok || !sandbox.workspaceId) {
    return { issue: issue.number, ok: false, pushed: false, error: `sandbox: ${sandbox.error ?? "unknown"}` };
  }
  try {
    const first = await implement(input, issue, sandbox.workspaceId);
    if (first.ok) return first;
    // One in-place retry: the workspace (and any partial sol work) survives,
    // so a second codex run resumes from the current tree state. Covers
    // OOM kills and transient crashes without burning a fresh VM slot.
    const second = await implement(input, issue, sandbox.workspaceId);
    return second.ok
      ? second
      : {
          ...second,
          error: `attempt1: ${truncate(first.error ?? "?", 300)} | attempt2: ${truncate(second.error ?? "?", 300)}`,
        };
  } finally {
    await cleanup(input, issue.number, sandbox.workspaceId);
  }
}

// ── Workflow ─────────────────────────────────────────────────────────────────

export default smithers((ctx) => {
  const input = ctx.input;
  const discovery = ctx.outputs.discovery?.at(-1);
  const issues = discovery?.ok ? discovery.issues : [];
  const laneRows = {
    sandbox: ctx.outputs.sandbox,
    implement: ctx.outputs.implement,
    pr: ctx.outputs.pr,
    cleanup: ctx.outputs.cleanup,
  };
  const settled =
    issues.length > 0 &&
    issues.every((issue) => {
      const impl = latestRow(laneRows.implement, issue.number);
      if (!impl) return false;
      return impl.pushed ? latestRow(laneRows.pr, issue.number) !== undefined : true;
    });

  return (
    <Workflow name="jjhub-issue-fleet">
      <UI entry="../ui/jjhub-issue-fleet.tsx" title="jjhub Issue Fleet" />
      <Sequence>
        <Task id="discover" output={outputs.discovery} timeoutMs={15 * 60_000}>
          {() => discover(input)}
        </Task>

        {discovery?.ok && issues.length > 0 ? (
          <Parallel id="lanes" subtreeConcurrency={input.laneConcurrency}>
            {issues.map((issue) => {
              const key = `i${issue.number}`;
              const impl = latestRow(laneRows.implement, issue.number);
              return (
                <Sequence key={key}>
                  <Task id={`${key}:lane`} output={outputs.implement} timeoutMs={80 * 60_000}>
                    {() => laneWork(input, issue, discovery.mainChangeId!)}
                  </Task>
                  {impl?.pushed ? (
                    <Task id={`${key}:pr`} output={outputs.pr} timeoutMs={15 * 60_000} retries={1}>
                      {() => openPr(input, issue, discovery, impl)}
                    </Task>
                  ) : null}
                </Sequence>
              );
            })}
          </Parallel>
        ) : null}

        {settled ? (
          <Task id="summary" output={outputs.summary} timeoutMs={60_000}>
            {() => {
              const prs = issues
                .map((issue) => latestRow(laneRows.pr, issue.number))
                .filter((row): row is z.infer<typeof prSchema> => Boolean(row?.ok && row.prUrl))
                .map((row) => ({ issue: row.issue, prUrl: row.prUrl! }));
              const landings = issues
                .map((issue) => latestRow(laneRows.pr, issue.number))
                .filter((row): row is z.infer<typeof prSchema> => Boolean(row?.landingNumber))
                .map((row) => ({ issue: row.issue, landingNumber: row.landingNumber! }));
              const failed = issues.flatMap((issue) => {
                const impl = latestRow(laneRows.implement, issue.number);
                const pr = latestRow(laneRows.pr, issue.number);
                if (impl && !impl.ok) return [{ issue: issue.number, stage: "lane", error: impl.error ?? "unknown" }];
                if (pr && !pr.ok) return [{ issue: issue.number, stage: "pr", error: pr.error ?? "unknown" }];
                return [];
              });
              return { prs, landings, failed };
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});

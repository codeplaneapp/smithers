// smithers-source: authored
// smithers-display-name: Review Cloud Ship
//
// Ships smithers review cloud per .smithers/specs/smithers-review-cloud.md:
// worker v2 (OIDC sessions, metered Anthropic proxy, quota, /metrics, admin),
// the zero-secret composite GitHub Action, verification gates, an approval
// gate, deploy to review.jjhub.tech, dogfood registration, and a live
// dogfood PR driven through the new action.
/** @jsxImportSource smithers-orchestrator */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Approval, Loop, Sequence, approvalDecisionSchema, createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

const inputSchema = z.object({
  spec: z.string().default(".smithers/specs/smithers-review-cloud.md"),
  serviceUrl: z.string().default("https://review.jjhub.tech"),
  maxFixRounds: z.number().int().default(3),
  dogfood: z.boolean().default(true),
});

const implementResultSchema = z.object({
  summary: z.string(),
  filesChanged: z.array(z.string()),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  implementWorker: implementResultSchema,
  implementAction: implementResultSchema,
  verify: z.object({ pass: z.boolean(), log: z.string() }),
  fixRound: z.object({ summary: z.string() }),
  deployApproval: approvalDecisionSchema,
  pushMain: z.object({ ok: z.boolean(), sha: z.string(), log: z.string() }),
  deploy: z.object({ ok: z.boolean(), log: z.string() }),
  registerDogfood: z.object({ ok: z.boolean(), detail: z.string() }),
  smoke: z.object({ ok: z.boolean(), detail: z.string() }),
  dogfood: z.object({
    status: z.enum(["merged", "blocked-on-funding", "failed", "skipped"]),
    prUrl: z.string().nullable(),
    notes: z.string(),
  }),
  report: z.object({ summary: z.string() }),
});

const REPO_ROOT = process.cwd();
const CONFIG_PATH = path.join(homedir(), ".smithers-review.json");

function tail(text: string, max = 6000): string {
  const t = text.trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

function sh(cmd: string[], env?: Record<string, string>): { ok: boolean; log: string } {
  try {
    const out = execFileSync(cmd[0], cmd.slice(1), {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...(env ?? {}) },
    });
    return { ok: true, log: tail(out) };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, log: tail(`${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? String(error)}`) };
  }
}

function reviewConfig(): { publishToken?: string; adminToken?: string; metricsToken?: string } & Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

// Generate-and-persist so redeploys keep stable operator tokens.
function ensureOperatorTokens(): { adminToken: string; metricsToken: string; publishToken: string } {
  const cfg = reviewConfig();
  let changed = false;
  if (!cfg.adminToken) {
    cfg.adminToken = `sra_${randomBytes(24).toString("hex")}`;
    changed = true;
  }
  if (!cfg.metricsToken) {
    cfg.metricsToken = `srm_${randomBytes(24).toString("hex")}`;
    changed = true;
  }
  if (changed) writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
  return {
    adminToken: String(cfg.adminToken),
    metricsToken: String(cfg.metricsToken),
    publishToken: String(cfg.publishToken ?? ""),
  };
}

const sharedRules = `
Ground rules (repo conventions, non-negotiable):
- Read the spec first: .smithers/specs/smithers-review-cloud.md. It is the contract; do not drift from it. Also read apps/review/README.md and apps/review/CONTRIBUTING.md.
- No mocks. Tests use real fixtures: locally generated RSA keypairs for JWT/JWKS, Bun.serve fixture servers for upstream fault paths via dependency-injection seams (never bun mock.module).
- One named export per file, filename matches the export. index.ts is for barrels only. Colocate by domain (sessions/, proxy/, metrics/, admin/), not by kind.
- Do NOT run git commit or git push. Another step handles commits.
- Other agents share this working tree. Touch only the files your task names.
- When done, run: pnpm -C apps/review typecheck && pnpm -C apps/review test. Fix what you broke before finishing.
- Your final answer must be JSON: {"summary": "...", "filesChanged": ["path", ...]}.
`;

const workerPrompt = `
Implement the service side of smithers review cloud in apps/review, per the spec's "Service" section.
${sharedRules}
Scope:
1. D1 schema + provisioning. Extend apps/review/alchemy.run.ts with an Alchemy D1 database binding (binding name DB) alongside the existing R2 bucket, plus new worker secret bindings: ADMIN_TOKEN from env REVIEW_ADMIN_TOKEN, METRICS_TOKEN from env REVIEW_METRICS_TOKEN, ANTHROPIC_API_KEY from env REVIEW_ANTHROPIC_API_KEY. Keep REVIEW_PUBLISH_TOKEN working as today. Tables (create via migration on first request or alchemy migrationsDir, your call, but keep it simple and idempotent): repos(repo PK, mode, prs_per_month, spend_cap_usd, created_at), api_keys(hash PK, owner, repos_json, created_at, revoked_at), sessions(hash PK, repo, pr, expires_at, spend_cap_usd, spent_usd, created_at), usage_events(id PK, repo, pr, model, input_tokens, output_tokens, cost_usd, kind, created_at), reviewed_prs(repo, pr, month, first_seen_at, PRIMARY KEY(repo, pr, month)).
2. POST /api/sessions per the spec: body {oidcToken} or {apiKey, repo, pr}. OIDC: verify RS256 signature against GitHub's JWKS (https://token.actions.githubusercontent.com/.well-known/jwks, cache in-memory), check iss https://token.actions.githubusercontent.com, aud "smithers-review", exp; identity is the repository claim; read pull_request number from the ref/claims when present, else accept a pr field in the body. Look up the repo registration; unknown repo => 403 with a JSON error naming the registration step. Quota: count rows in reviewed_prs for the current calendar month; if this (repo,pr) is new and count >= prs_per_month => 402. Insert reviewed_prs on first session for a (repo,pr,month). Mint a 256-bit random session token, store SHA-256 hash with TTL 2h and the plan's spend cap, reply {token, expiresAt, mode, plan: {prsPerMonth, used}, anthropicBaseUrl: "<origin>/anthropic", publishUrl: "<origin>"}.
3. Anthropic proxy at /anthropic/v1/* per the spec: auth via x-api-key or authorization bearer holding a session token or api key; 401 unknown, 402 over spend cap. Forward to https://api.anthropic.com with the real ANTHROPIC_API_KEY secret, stream the response body through unmodified. Meter: parse usage from SSE message_start/message_delta frames or non-streaming JSON; append usage_events with cost from a small static per-model USD price table (claude-fable-5, claude-opus-4-8, claude-sonnet-5 at current public prices; unknown model => 0 cost, still record tokens); update sessions.spent_usd. Only paths starting /v1/ are forwarded; anything else 404. Inject a fetch seam so tests can point the upstream at a Bun.serve fixture.
4. GET /metrics per the spec: Bearer METRICS_TOKEN, Prometheus text exposition aggregated from D1: review_tokens_total{repo,model,kind}, review_spend_usd_total{repo,model}, review_prs_reviewed_total{repo}, review_quota_remaining{repo}, review_proxy_errors_total{repo,status}, review_sessions_total{repo,result}.
5. Admin endpoints, Bearer ADMIN_TOKEN: POST /api/admin/repos upsert {repo, mode: "auto"|"comment", prsPerMonth, spendCapUsd}; GET /api/admin/repos list with month-to-date usage; POST /api/admin/keys {owner, repos} returns a new srk_ key once and stores its hash; GET /api/admin/usage summary by repo/model/day.
6. POST /api/walkthroughs: keep the legacy REVIEW_PUBLISH_TOKEN working and additionally accept valid session tokens and api keys.
7. All token comparisons constant-time on hashes. Never log tokens.
8. bun tests under apps/review/tests covering: OIDC verify accept + reject (signature, audience, expiry) using a generated RSA keypair and a JWKS served from a Bun.serve fixture wired through a JWKS-URL seam; quota counting incl. re-review free in same month; proxy auth, metering math from a fixture upstream that replays a recorded SSE usage stream, and spend-cap 402; /metrics exposition shape; admin upsert/list/mint. Use Miniflare-style direct worker.fetch invocation with an in-memory D1 (bun:sqlite behind the same interface) via a DB seam if a real D1 binding is not testable locally.
`;

const actionPrompt = `
Implement the client side of smithers review cloud: the zero-secret composite GitHub Action, per the spec's "Composite action" section and the README template.
${sharedRules}
Scope:
1. apps/review/action/action.yml — composite action. Inputs: service-url (default https://review.jjhub.tech). Steps: setup bun (oven-sh/setup-bun@v2.2.0, bun 1.3.13) and pnpm/node like .github/workflows/pr-review.yml does, pnpm install --frozen-lockfile at the action's repo root (github.action_path/../../..), install @openai/codex when CODEX_AUTH_JSON is present and otherwise install @anthropic-ai/claude-code for the unavailable-Codex fallback, then bun run the gate/session/review driver scripts below. The user's repo is already checked out at the workflow's workspace; the smithers checkout lives at the action path.
2. apps/review/action/src/ — the action logic as bun-executable TypeScript, one export per file, unit-testable: gateEvent.ts (decide run/skip from the GitHub event payload: pull_request non-draft same-repo; issue_comment must be on a PR, body starting "@smithers review", author_association OWNER/MEMBER/COLLABORATOR; emits the PR number and head ref), createSession.ts (fetch the Actions OIDC token using ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN env with audience smithers-review, POST {oidcToken} to <service-url>/api/sessions, handle 402 as neutral quota skip and 403 as not-registered notice), and runReview.ts (resolve and fetch the PR head into the workspace checkout for issue_comment, then exec bun <smithersRoot>/apps/review/src/cli/main.ts <workspace> --pr <n> --publish). Resolve inference before the exec: CODEX_AUTH_JSON wins, is materialized into an isolated CODEX_HOME then scrubbed, and selects SMITHERS_REVIEW_ENGINE=codex; otherwise CLAUDE_CODE_OAUTH_TOKEN selects the Claude subscription fallback; without either subscription credential, select Claude and set ANTHROPIC_BASE_URL=<session.anthropicBaseUrl> plus ANTHROPIC_API_KEY=<session.token> for the metered proxy. Every path sets SMITHERS_REVIEW_PUBLISH_URL=<session.publishUrl>, SMITHERS_REVIEW_PUBLISH_TOKEN=<session.token>, and passes through GH_TOKEN. Mode rule: pull_request on a comment-mode repo exits neutral with a notice naming "@smithers review".
3. apps/review/src/workflow/createReviewAgents.ts — make Codex the default whenever the CLI is installed and authenticated, with an explicit SMITHERS_REVIEW_ENGINE override for diagnostics. In the Codex path, use gpt-5.6-sol at xhigh effort for review and verdict verification, and gpt-5.6-luna at explicit medium effort for narration and quiz generation. If Codex is unavailable, fall back to Claude (Fable primary, Opus failover). When both ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY are set, construct that Claude fallback in API-key mode so zero-secret CI runs under the proxy deterministically; otherwise use Claude subscription auth. Never run Claude in parallel with a healthy Codex path merely to provide fallback behavior. Check the agent options in node_modules/smithers-orchestrator rather than guessing.
4. bun tests for gateEvent, the session client (402/403/200 paths against a Bun.serve fixture service), engine resolution, and the exact Codex role split (Sol review/verify, Luna narrate/quiz). No tests that hit GitHub.
5. Keep apps/review/README.md truthful: if any implemented behavior differs from the README's workflow template or trigger phrasing, fix the docs in the same change.
`;

const dogfoodPrompt = `
Dogfood smithers review cloud end to end on the real repo using gh and git.
Steps, in order:
1. Create an isolated worktree: git worktree add /tmp/review-cloud-dogfood origin/main (never switch branches in the main working tree). Work only inside it on branch dogfood/review-cloud-action.
2. Replace .github/workflows/pr-review.yml content with the zero-secret template from apps/review/README.md ("Add it to your repo" section): pull_request + issue_comment triggers, id-token write, uses smithersai/smithers/apps/review/action@main. Keep a concurrency group keyed on the PR/issue number.
3. Commit (emoji conventional style, Co-Authored-By: Codex <noreply@openai.com>), push the branch, open a PR titled "👷 ci(review): dogfood the zero-secret review action" with a body that names the spec.
4. The PR push itself triggers the OLD pr-review.yml from main on this PR, and the NEW workflow file only runs once merged — so to test the action pre-merge, also comment "@smithers review" on the PR and watch for the run of the workflow from the PR branch if GitHub starts one; otherwise rely on the run of the action triggered after you merge (step 6) on a follow-up trivial PR. Prefer the simplest path that yields one real run of the composite action.
5. Watch runs with gh run list / gh run watch (timeout 25 minutes). Success = a run that authenticates via /api/sessions (no secrets), posts a PR review, and links a hosted walkthrough.
6. Outcomes: if the action run posts the review, merge the PR (squash) and report status "merged". If the proxy rejects with credit/billing/insufficient-funds errors from Anthropic, close the PR unmerged, report status "blocked-on-funding" and quote the exact error. Anything else: leave the PR open, report status "failed" with run URLs and log excerpts.
7. Clean up: git worktree remove /tmp/review-cloud-dogfood --force.
Final answer JSON: {"status": "merged"|"blocked-on-funding"|"failed", "prUrl": string|null, "notes": "what happened, run URLs, errors"}.
`;

export default smithers((ctx) => {
  const spec = ctx.input.spec ?? ".smithers/specs/smithers-review-cloud.md";
  const serviceUrl = (ctx.input.serviceUrl ?? "https://review.jjhub.tech").replace(/\/$/, "");
  const maxFixRounds = ctx.input.maxFixRounds ?? 3;
  const latestVerify = ctx.latest("verify", "verify");
  const approval = ctx.outputMaybe(outputs.deployApproval, { nodeId: "approve-deploy" });

  return (
    <Workflow name="review-cloud-ship" cache>
      <Task id="implement-worker" output={outputs.implementWorker} agent={agents.implement} timeoutMs={75 * 60 * 1000} retries={2}>
        {workerPrompt}
      </Task>

      <Task
        id="implement-action"
        output={outputs.implementAction}
        agent={agents.implement}
        dependsOn={["implement-worker"]}
        timeoutMs={60 * 60 * 1000}
        retries={2}
      >
        {actionPrompt}
      </Task>

      <Loop until={latestVerify?.pass === true} maxIterations={maxFixRounds + 1} onMaxReached="fail">
        <Sequence>
          <Task id="verify" output={outputs.verify} dependsOn={["implement-action"]}>
            {() => {
              const typecheck = sh(["pnpm", "-C", "apps/review", "typecheck"]);
              const tests = typecheck.ok ? sh(["pnpm", "-C", "apps/review", "test"]) : { ok: false, log: "(skipped: typecheck failed)" };
              return {
                pass: typecheck.ok && tests.ok,
                log: tail(`== typecheck ==\n${typecheck.log}\n== bun test ==\n${tests.log}`),
              };
            }}
          </Task>
          <Task
            id="fix-round"
            output={outputs.fixRound}
            agent={agents.implement}
            skipIf={ctx.latest("verify", "verify")?.pass === true}
            timeoutMs={45 * 60 * 1000}
            retries={2}
          >
            {`The smithers review cloud implementation fails verification. Fix the failures without weakening tests or drifting from ${spec}.
${sharedRules}
Failure log:
${ctx.latest("verify", "verify")?.log ?? "(first verify pending)"}
Final answer JSON: {"summary": "what you fixed"}.`}
          </Task>
        </Sequence>
      </Loop>

      <Approval
        id="approve-deploy"
        output={outputs.deployApproval}
        onDeny="fail"
        request={{
          title: "Deploy smithers review cloud to review.jjhub.tech?",
          summary: `Verification: ${latestVerify?.pass ? "green" : "pending"}. Worker: ${
            ctx.outputMaybe(outputs.implementWorker, { nodeId: "implement-worker" })?.summary ?? "pending"
          }. Action: ${ctx.outputMaybe(outputs.implementAction, { nodeId: "implement-action" })?.summary ?? "pending"}. Approving pushes apps/review to main, deploys the worker (D1 + proxy + metrics), registers smithersai/smithers, and opens a dogfood PR.`,
        }}
      />

      {approval?.approved ? (
        <Sequence>
          <Task id="push-main" output={outputs.pushMain} retries={1}>
            {() => {
              // Hard-fail (throw) so the deploy chain never runs on a bad push.
              const add = sh(["git", "add", "apps/review", ".smithers/specs/smithers-review-cloud.md"]);
              if (!add.ok) throw new Error(`git add failed:\n${add.log}`);
              const commit = sh([
                "git",
                "commit",
                "-m",
                "✨ feat(review): smithers review cloud — OIDC sessions, metered proxy, quota, /metrics, zero-secret action\n\nImplements .smithers/specs/smithers-review-cloud.md.\n\nCo-Authored-By: Codex <noreply@openai.com>",
                "--",
                "apps/review",
              ]);
              const committed = commit.ok || commit.log.includes("nothing to commit");
              if (!committed) throw new Error(`git commit failed:\n${commit.log}`);
              sh(["git", "fetch", "origin", "main"]);
              // The shared worktree often has other agents' uncommitted files, so
              // never rebase here: push only when it is a fast-forward, else stop
              // for the operator.
              const fastForward = sh(["git", "merge-base", "--is-ancestor", "origin/main", "HEAD"]);
              if (!fastForward.ok) {
                throw new Error("origin/main has new commits; rebasing under other agents' uncommitted changes is unsafe. Reconcile manually, then retry this task.");
              }
              const push = sh(["git", "push", "origin", "HEAD:main"]);
              if (!push.ok) throw new Error(`git push failed:\n${push.log}`);
              const sha = sh(["git", "rev-parse", "HEAD"]).log.trim();
              return { ok: true, sha, log: tail(`${commit.log}\n${push.log}`) };
            }}
          </Task>

          <Task id="deploy" output={outputs.deploy} dependsOn={["push-main"]}>
            {() => {
              const tokens = ensureOperatorTokens();
              if (!tokens.publishToken) throw new Error("publishToken missing from ~/.smithers-review.json");
              // "run deploy": bare `pnpm deploy` resolves to pnpm's built-in
              // workspace-deploy command, not the package script.
              const result = sh(["pnpm", "-C", "apps/review", "run", "deploy"], {
                REVIEW_PUBLISH_TOKEN: tokens.publishToken,
                REVIEW_ADMIN_TOKEN: tokens.adminToken,
                REVIEW_METRICS_TOKEN: tokens.metricsToken,
                REVIEW_ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
              });
              if (!result.ok) throw new Error(`alchemy deploy failed:\n${result.log}`);
              return { ok: true, log: result.log };
            }}
          </Task>

          <Task id="register-dogfood" output={outputs.registerDogfood} dependsOn={["deploy"]}>
            {async () => {
              const { adminToken } = ensureOperatorTokens();
              const res = await fetch(`${serviceUrl}/api/admin/repos`, {
                method: "POST",
                headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
                body: JSON.stringify({ repo: "smithersai/smithers", mode: "auto", prsPerMonth: 1000, spendCapUsd: 20 }),
              });
              return { ok: res.ok, detail: `${res.status} ${await res.text()}`.slice(0, 2000) };
            }}
          </Task>

          <Task id="smoke" output={outputs.smoke} dependsOn={["register-dogfood"]}>
            {async () => {
              const { adminToken, metricsToken } = ensureOperatorTokens();
              const checks: string[] = [];
              let ok = true;
              const expect = (name: string, cond: boolean, detail: string) => {
                checks.push(`${cond ? "✓" : "✗"} ${name}: ${detail}`);
                ok = ok && cond;
              };
              const badSession = await fetch(`${serviceUrl}/api/sessions`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ oidcToken: "not-a-jwt" }),
              });
              expect("sessions rejects garbage", badSession.status === 400 || badSession.status === 401, `status ${badSession.status}`);
              const badProxy = await fetch(`${serviceUrl}/anthropic/v1/messages`, {
                method: "POST",
                headers: { "x-api-key": "srk_invalid", "content-type": "application/json" },
                body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
              });
              expect("proxy rejects unknown key", badProxy.status === 401, `status ${badProxy.status}`);
              const metrics = await fetch(`${serviceUrl}/metrics`, { headers: { authorization: `Bearer ${metricsToken}` } });
              const metricsBody = metrics.ok ? await metrics.text() : "";
              expect("metrics serves exposition", metrics.ok && metricsBody.includes("review_"), `status ${metrics.status}`);
              const metricsUnauth = await fetch(`${serviceUrl}/metrics`);
              expect("metrics requires bearer", metricsUnauth.status === 401, `status ${metricsUnauth.status}`);
              const repos = await fetch(`${serviceUrl}/api/admin/repos`, { headers: { authorization: `Bearer ${adminToken}` } });
              const reposBody = repos.ok ? await repos.text() : "";
              expect("dogfood repo registered", repos.ok && reposBody.includes("smithersai/smithers"), `status ${repos.status}`);
              return { ok, detail: checks.join("\n") };
            }}
          </Task>

          <Task
            id="dogfood-pr"
            output={outputs.dogfood}
            agent={agents.implement}
            dependsOn={["smoke"]}
            skipIf={(ctx.input.dogfood ?? true) === false}
            timeoutMs={60 * 60 * 1000}
            retries={1}
            continueOnFail
          >
            {dogfoodPrompt}
          </Task>

          <Task id="report" output={outputs.report} dependsOn={["dogfood-pr"]}>
            {() => {
              const push = ctx.outputMaybe(outputs.pushMain, { nodeId: "push-main" });
              const deploy = ctx.outputMaybe(outputs.deploy, { nodeId: "deploy" });
              const smoke = ctx.outputMaybe(outputs.smoke, { nodeId: "smoke" });
              const dogfood = ctx.outputMaybe(outputs.dogfood, { nodeId: "dogfood-pr" });
              return {
                summary: [
                  `push-main: ${push?.ok ? `ok @ ${push.sha}` : "FAILED"}`,
                  `deploy: ${deploy?.ok ? "ok" : "FAILED"}`,
                  `smoke:\n${smoke?.detail ?? "missing"}`,
                  `dogfood: ${dogfood?.status ?? "missing"} ${dogfood?.prUrl ?? ""}\n${dogfood?.notes ?? ""}`,
                ].join("\n\n"),
              };
            }}
          </Task>
        </Sequence>
      ) : null}
    </Workflow>
  );
});

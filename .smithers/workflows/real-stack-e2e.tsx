// smithers-display-name: Real-Stack E2E (no mocks)
/** @jsxImportSource smithers-orchestrator */
/**
 * real-stack-e2e — drive apps/smithers to a fully real, zero-mock e2e suite,
 * then keep improving quality and coverage in a ralph loop.
 *
 * Goal: a `playwright.real.config.ts` suite in apps/smithers that runs the
 * ENTIRE stack with 0 mocks:
 *   - ../plue docker compose  = smithers cloud (postgres, migrate, seed,
 *     repo-host, api on :4000)
 *   - the smithers gateway running IN THIS CWD as a plain local process
 *     (`PORT=7342 bun .smithers/gateway.ts`), never the dev gateway on 7331
 *   - the real Cloudflare Worker code for /api/chat with a REAL LLM upstream:
 *     Cerebras when CEREBRAS_API_KEY is set, else Gemini Flash through
 *     Gemini's OpenAI-compatible endpoint (GEMINI_API_KEY)
 *   - real gateway workflow runs that make REAL Claude LLM calls through the
 *     host claude CLI (already authenticated on this machine)
 *
 * Agent roles (per operator instruction): Claude Fable plans and reviews;
 * Codex (ChatGPT auth, model gpt-5.5) implements, with Claude fallback.
 *
 * Phases:
 *   1. Preflight loop — compute probes for docker / plue / claude CLI + auth
 *      (real one-line completion on the fable model) / chat upstream (real
 *      completion against Cerebras or Gemini) / codex auth. Anything missing
 *      mounts a HumanTask that blocks the run; answers persist to
 *      apps/smithers/.env.e2e.local (gitignored) and the probe re-runs.
 *   2. Tickets — six subgoals, each defined as "this playwright spec passes
 *      against the full real stack". Written to .smithers/tickets/, executed
 *      sequentially (shared git index + shared ports).
 *   3. Per-ticket loop — implement (Codex) → verify (compute: actually runs
 *      the ticket's playwright command) → audit (deterministic no-mock grep)
 *      → review (Claude Fable). Loop until all pass, max 5, fail loudly.
 *   4. Ralph quality loop — after the basics are green: plan (Fable) picks
 *      1-3 high-value items (code quality, missing unit tests, missing e2e
 *      coverage), implement (Codex), verify (FULL gate: typecheck + unit +
 *      real suite), audit, review (Fable), push per green iteration. Repeats
 *      until the planner declares done or 12 iterations.
 *   5. Finalize — push any remainder, then write an evidence report.
 */
import {
  ClaudeCodeAgent,
  CodexAgent,
  createSmithers,
  HumanTask,
  Loop,
  Sequence,
} from "smithers-orchestrator";
import { z } from "zod/v4";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths & helpers (resolved from this file so cwd does not matter)
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url)); // .smithers/workflows
const REPO = resolve(HERE, "../..");
const ENV_FILE = resolve(REPO, "apps/smithers/.env.e2e.local");
const PLUE_DIR = process.env.PLUE_DIR ?? resolve(REPO, "../plue");
const TICKET_DIR = resolve(REPO, ".smithers/tickets/real-stack-e2e");

const GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
// Verified live against the OpenAI-compatible endpoint's /models list
// (gemini-flash-latest is NOT served there).
const GEMINI_FLASH_MODEL = process.env.SMITHERS_E2E_CHAT_MODEL ?? "gemini-2.5-flash";
const CODEX_MODEL = process.env.SMITHERS_E2E_CODEX_MODEL ?? "gpt-5.5";
const RALPH_MAX_ITERATIONS = 12;

function tailOf(s: string, n: number): string {
  return s.length <= n ? s : "…(truncated)…\n" + s.slice(s.length - n);
}

function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(ENV_FILE)) return out;
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[2] !== "") out[m[1]] = m[2];
  }
  return out;
}

type ShResult = { exitCode: number; tail: string; durationMs: number };

async function sh(
  cmd: string,
  opts: { timeoutMs: number; env?: Record<string, string>; cwd?: string },
): Promise<ShResult> {
  const started = Date.now();
  const proc = Bun.spawn(["bash", "-lc", cmd], {
    cwd: opts.cwd ?? REPO,
    env: { ...process.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {}
  }, opts.timeoutMs);
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(killer);
  const combined =
    out +
    (err ? "\n[stderr]\n" + err : "") +
    (timedOut ? `\n[workflow] command killed after ${opts.timeoutMs}ms timeout` : "");
  return { exitCode, tail: tailOf(combined, 8000), durationMs: Date.now() - started };
}

/** The real chat upstream: Cerebras when its key exists, else Gemini Flash. */
function chatUpstream(): { provider: "cerebras" | "gemini"; key: string; baseUrl: string; model: string } | null {
  const fileEnv = readEnvFile();
  const get = (k: string) => process.env[k] || fileEnv[k] || "";
  const cerebras = get("CEREBRAS_API_KEY");
  if (cerebras) {
    return {
      provider: "cerebras",
      key: cerebras,
      baseUrl: get("CEREBRAS_BASE_URL") || "https://api.cerebras.ai/v1",
      model: get("CEREBRAS_MODEL") || "gpt-oss-120b",
    };
  }
  const gemini = get("GEMINI_API_KEY");
  if (gemini) {
    return { provider: "gemini", key: gemini, baseUrl: GEMINI_OPENAI_BASE, model: GEMINI_FLASH_MODEL };
  }
  return null;
}

/** Env handed to every verify command: real secrets + plue location + the
 *  resolved chat upstream mapped onto the Worker's CEREBRAS_* binding names
 *  (binding names, not a mock — the Worker code reads these). */
function verifyEnv(): Record<string, string> {
  const up = chatUpstream();
  const chat: Record<string, string> = up
    ? {
        CEREBRAS_API_KEY: up.key,
        CEREBRAS_BASE_URL: up.baseUrl,
        CEREBRAS_MODEL: up.model,
        SMITHERS_E2E_CHAT_PROVIDER: up.provider,
      }
    : {};
  return { ...readEnvFile(), ...chat, PLUE_DIR };
}

// ---------------------------------------------------------------------------
// Agents — Claude Fable plans/reviews, Codex implements (Claude fallback)
// ---------------------------------------------------------------------------

// Model ids verified live against this account's claude CLI (claude-sonnet-4-7
// 404s: "may not exist or you may not have access").
const fable = new ClaudeCodeAgent({ model: "claude-fable-5", cwd: REPO });
const sonnet = new ClaudeCodeAgent({ model: "claude-sonnet-4-6", cwd: REPO });
const opus = new ClaudeCodeAgent({ model: "claude-opus-4-8", cwd: REPO });
const codexImpl = new CodexAgent({ model: CODEX_MODEL, cwd: REPO, skipGitRepoCheck: true });

const planners = [fable, sonnet]; // planning + review: Fable first
function implementers(codexOk: boolean) {
  return codexOk ? [codexImpl, opus, sonnet] : [opus, sonnet];
}

// ---------------------------------------------------------------------------
// Shared prompt fragments
// ---------------------------------------------------------------------------

const GROUND_RULES = `## Ground rules (non-negotiable)
- Repo root: ${REPO}. Plue checkout (smithers cloud): ${PLUE_DIR}.
- ZERO MOCKS. Nothing under apps/smithers/tests/e2e-real/, apps/smithers/playwright.real.config.ts, or scripts/e2e-real/ may use page.route()/routeWebSocket, import anything from apps/smithers/tests/fixtures/, or rely on hardcoded/fallback stand-in data. Real backends only: real Plue compose, the real gateway process in this repo's cwd, a REAL LLM chat upstream (Cerebras or Gemini Flash through Gemini's OpenAI-compatible endpoint — both are real model APIs), real Claude agent calls. Deliberate failure-injection against a real fault path is fine; fabricated responses are not.
- Do NOT touch the existing fixture suite: apps/smithers/playwright.config.ts and apps/smithers/tests/e2e/** must remain byte-identical. The real suite is additive.
- Work directly on main. Atomic commits, emoji + conventional-commit subject, ending with the trailer "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>". Use explicit pathspecs with git add (never "git add -A" — other agents may share this working tree). Commit when your ticket's verify command passes locally. Do NOT push; the workflow pushes after gates.
- Secrets live in apps/smithers/.env.e2e.local (gitignored). Source it when you need CEREBRAS_API_KEY / GEMINI_API_KEY / CLAUDE_CODE_OAUTH_TOKEN. NEVER commit it, copy values into tracked files, or print values to stdout/logs. (Plue's seeded dev tokens like smithers_deadbeef… are public fixtures committed in plue's own repo; those may appear in specs.)
- Ports (all env-overridable, defaults chosen to avoid the fixture suite and dev): plue api 127.0.0.1:4000 (fixed by plue's compose), e2e gateway 127.0.0.1:7342 — a LOCAL process: \`PORT=7342 HOST=127.0.0.1 bun .smithers/gateway.ts\` (NOT a container), real app origin 127.0.0.1:5375, real worker leg 127.0.0.1:5376. Never bind the fixture ports 5275-5292 and never clobber or kill the dev gateway on 7331.
- The e2e gateway shares .smithers/smithers.db with any dev gateway on this machine. Specs must therefore assert on the runId THEY launched, never on list counts, and the real config runs with workers: 1.
- Everything you build must be idempotent: re-running the stack boot with services already up is a no-op; playwright webServer entries use reuseExistingServer.
- Asserting on LLM output: assert BEHAVIOR (a non-empty assistant message streamed, the run reached finished, structured output validated) — never exact model text.
- The shell-exported ANTHROPIC_API_KEY on this machine has NO credits. Any script that spawns the claude CLI directly (probes, helpers) must \`unset ANTHROPIC_API_KEY\` first so the CLI uses subscription auth, unless apps/smithers/.env.e2e.local explicitly supplies a working key.
- App code style (if you touch src/): zero useState/useEffect, state in zustand; one named export per file, filename = export name; index.ts is barrels only; colocate by domain.`;

const OPS_NOTES = `## When you are blocked
If you are missing a credential, a human decision, or hit something destructive/irreversible, DO NOT guess and DO NOT fake it. Raise a blocking human request and wait:
  bunx smithers-orchestrator ask-human "<exact question>" --context "<what you tried>"
(SMITHERS_RUN_ID is already in your environment, so it attaches to this run.) The operator answers via "smithers human inbox" / "smithers human answer".

## Verification
The workflow will run your verify command itself after you finish, with apps/smithers/.env.e2e.local + the resolved chat upstream + PLUE_DIR exported. Run it yourself first; only finish when it exits 0 from a cold start (stack down → up). Tail docker logs, the gateway log, and the playwright report when it fails — fix the real cause, never weaken an assertion to pass.`;

// ---------------------------------------------------------------------------
// Tickets — each one is "this spec passes against the full real stack"
// ---------------------------------------------------------------------------

type Ticket = {
  id: string;
  title: string;
  md: string;
  verifyCmd: string;
  verifyTimeoutMs: number;
};

const TICKETS: Ticket[] = [
  {
    id: "t1-real-stack-boot",
    title: "Real stack boots: plue compose + cwd gateway + real playwright config",
    verifyCmd:
      "pnpm -C apps/smithers exec playwright test --config playwright.real.config.ts tests/e2e-real/stack.spec.ts",
    verifyTimeoutMs: 45 * 60 * 1000,
    md: `Build the no-mock stack skeleton. Deliverables:

1. \`scripts/e2e-real/plue-up.sh\`:
   - default action (no arg): \`docker compose up -d postgres migrate seed repo-host api\` in \$PLUE_DIR (default ../plue), wait for http://127.0.0.1:4000/api/health (up to 180s — migrations dominate cold boot), then \`exec sleep infinity\` so a playwright webServer can own the process. Plue keeps running when playwright kills the sleeper; reuseExistingServer makes the next run skip the boot.
   - \`down\` / \`status\` args for humans: act and exit (down = compose down in \$PLUE_DIR).
   - Distinct non-zero exit code per failed leg. Idempotent: compose up on a running stack is a no-op.
2. \`apps/smithers/playwright.real.config.ts\`:
   - testDir tests/e2e-real, workers: 1 (shared gateway DB + shared plue state), webServer entries:
     (a) plue: command \`bash ../../scripts/e2e-real/plue-up.sh\`, url http://127.0.0.1:4000/api/health, reuseExistingServer: true, timeout 240s.
     (b) gateway in the cwd: command \`bun ../../.smithers/gateway.ts\`, env { PORT: "7342", HOST: "127.0.0.1" }, url http://127.0.0.1:7342/health, reuseExistingServer: true. (gateway.ts chdir's itself to the repo root, so the command cwd does not matter.) Inject the values read from apps/smithers/.env.e2e.local (plain fs read in the config, tolerate absence) into this leg's env so agent credentials reach the claude CLI processes the gateway spawns.
     (c) vite on 127.0.0.1:5375 with SMITHERS_AUTH_PROXY_TARGET + SMITHERS_PLATFORM_PROXY_TARGET = http://127.0.0.1:4000 and SMITHERS_GATEWAY_PROXY_TARGET = http://127.0.0.1:7342. No fixture processes anywhere in this config.
   - Seed onboarding-completed localStorage for the app origin like the fixture config does (that is app state, not a mock).
3. \`apps/smithers/tests/e2e-real/stack.spec.ts\`:
   - request GET /health on the app origin -> JSON {ok:true} (proves vite -> cwd gateway proxy);
   - request GET /workflows on the app origin -> JSON listing at least one workflow (proves the gateway mounted the local pack);
   - request GET /api/user anonymously -> 401 with a JSON body (proves vite -> REAL plue api, not the SPA fallback);
   - page loads / and the app shell renders.

Success criteria:
- The verify command exits 0 from a cold start (plue down, no gateway on 7342).
- Running it again with everything already up is also green and faster (reuse).
- No file under tests/e2e-real or the real config imports from tests/fixtures.
Study apps/smithers/vite.config.ts for the exact proxy env var names, scripts/dev-with-plue.sh for the plue boot/health contract and the gateway reuse/refuse-to-clobber rules, and apps/smithers/playwright.config.ts ONLY for the storageState pattern.`,
  },
  {
    id: "t2-real-signin",
    title: "Sign-in against the REAL plue api with a real seeded token",
    verifyCmd:
      "pnpm -C apps/smithers exec playwright test --config playwright.real.config.ts tests/e2e-real/signin.spec.ts",
    verifyTimeoutMs: 30 * 60 * 1000,
    md: `\`apps/smithers/tests/e2e-real/signin.spec.ts\`: drive the app's token sign-in UI against the REAL plue api (port 4000) and land signed in.

The real token: plue's compose seeds postgres from \$PLUE_DIR/db/seed.sql, which inserts user alice (display name "Alice Dev", admin) and the access token \`smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\` (sha-256 hash stored in access_tokens; scopes write:repository,write:user,write:organization). The api validates \`Authorization: Bearer <token>\` by hashing and looking up. Use that seeded token in the spec; cite db/seed.sql in a comment. (Compose also sets SMITHERS_ENABLE_E2E_TEST_ROUTES=true if you need /_test/ routes; minting is NOT required since the seed token exists.)

Success criteria:
- Spec starts signed out (anonymous /api/user is 401), performs token sign-in through the UI, asserts the signed-in state shows "Alice Dev" exactly as stored in plue's postgres, and survives a page reload still signed in.
- No fakePlueHost / fixture imports; the token comes from real plue's own seed, not from a fake's seed table.
- Pin the plue contract you depend on (token format, /api/user response fields) in a NEW bun assumption test under apps/smithers/tests/assumptions/ that probes the live plue api, guarded by an env flag so it only runs when plue is up. Do not modify the existing fixture-suite assumption files.`,
  },
  {
    id: "t3-real-chat-llm",
    title: "Chat streams a REAL LLM completion (Gemini Flash or Cerebras) through the real Worker",
    verifyCmd:
      "pnpm -C apps/smithers exec playwright test --config playwright.real.config.ts tests/e2e-real/chat.spec.ts",
    verifyTimeoutMs: 30 * 60 * 1000,
    md: `Wire /api/chat to a real LLM and prove it in the UI.

The Worker (apps/smithers/src/worker.ts) already supports upstream overrides via its env bindings: CEREBRAS_API_KEY (required), CEREBRAS_BASE_URL (default https://api.cerebras.ai/v1), CEREBRAS_MODEL (default gpt-oss-120b). Those are binding NAMES; pointing them at another real OpenAI-compatible LLM API is not a mock.

1. \`scripts/e2e-real/worker.ts\`: boot the REAL Worker code (same pattern as tests/fixtures/workerHost.ts — study it, but do NOT import it or the cerebrasUpstream fixture) on 127.0.0.1:5376. Upstream selection at boot:
   - CEREBRAS_API_KEY set -> use it with the Cerebras defaults.
   - else GEMINI_API_KEY set -> bindings CEREBRAS_API_KEY=\$GEMINI_API_KEY, CEREBRAS_BASE_URL=${GEMINI_OPENAI_BASE}, CEREBRAS_MODEL=\${SMITHERS_E2E_CHAT_MODEL:-${GEMINI_FLASH_MODEL}} (Gemini's OpenAI-compatible endpoint, real Gemini Flash completions).
   - neither set -> REFUSE to boot with a clear error naming both env vars. No fallback, no canned data.
   Log which provider/model was selected (never the key).
2. Extend playwright.real.config.ts: worker webServer leg + SMITHERS_CHAT_PROXY_TARGET=http://127.0.0.1:5376 on the vite leg. Load the keys from apps/smithers/.env.e2e.local AND process.env into the worker leg's env (read the file in the config; never commit values).
3. \`apps/smithers/tests/e2e-real/chat.spec.ts\`: open the chat surface, send a short prompt (e.g. "Reply with one short sentence."), and assert a real assistant message streams back: non-empty assistant text appears, no error state, and the /api/chat response was a 200 SSE/stream. Generous timeout (real model latency). Assert behavior, not exact text. The spec must pass identically on either upstream.

Success criteria: verify command exits 0 with a REAL upstream (the workflow's preflight already proved the resolved upstream completes a prompt). The worker leg refuses to boot without a key. Zero fixture imports. If the Gemini model id 404s, list the live models via GET ${GEMINI_OPENAI_BASE}/models with the key and pick the current flash id; document the choice.`,
  },
  {
    id: "t4-real-gateway-run",
    title: "Launch a gateway workflow run that makes a REAL Claude LLM call, watch it finish in the UI",
    verifyCmd:
      "bash scripts/e2e-real/probe-agent-cred.sh && pnpm -C apps/smithers exec playwright test --config playwright.real.config.ts tests/e2e-real/gatewayRun.spec.ts",
    verifyTimeoutMs: 40 * 60 * 1000,
    md: `Make the cwd gateway execute a real agent workflow end to end.

1. \`.smithers/workflows/e2e-probe.tsx\`: a minimal one-task agent workflow (output schema like { answer: z.string() }) whose Task uses a ClaudeCodeAgent (model claude-sonnet-4-6, cheap — NOT 4-7, which 404s on this account) and asks for a one-line answer. The gateway auto-mounts every .smithers/workflows/*.tsx at boot, so creating the file registers it on next gateway boot.
   - Mount caveat: an ALREADY-RUNNING e2e gateway on 7342 will not see the new file. If 7342 is up and /workflows lacks e2e-probe, kill ONLY that gateway process (the one bound to 7342; never 7331) and let playwright's webServer reboot it. Script this guard into the spec setup or a tiny stack helper.
2. \`scripts/e2e-real/probe-agent-cred.sh\` — ASSUMPTION PROBE, must run before the spec: source apps/smithers/.env.e2e.local if present, \`unset ANTHROPIC_API_KEY\` unless that file supplied one (see ground rules: the shell-exported key has no credits), then run \`claude -p "Say OK" --model claude-sonnet-4-6\` ON THE HOST (the gateway spawns the same host CLI) and require exit 0 with non-empty output. If this fails, the spec is doomed — fail fast naming the missing credential (claude /login, claude setup-token, or ANTHROPIC_API_KEY).
3. \`apps/smithers/tests/e2e-real/gatewayRun.spec.ts\`: through the UI (study tests/e2e/launchRun.spec.ts + gatewayRun.spec.ts for the surfaces, but target the real config), launch the e2e-probe workflow on the real gateway, watch live run events arrive, and assert THAT run (by its runId) reaches finished with a visible non-empty output. Timeout generous (a real Claude call takes 30-120s).

Success criteria: probe script + spec both green via the verify command. The LLM call is real (visible token usage / agent events in the gateway run, no canned text).`,
  },
  {
    id: "t5-real-approval",
    title: "Human approval round-trip through the real gateway UI",
    verifyCmd:
      "pnpm -C apps/smithers exec playwright test --config playwright.real.config.ts tests/e2e-real/approval.spec.ts",
    verifyTimeoutMs: 30 * 60 * 1000,
    md: `1. \`.smithers/workflows/e2e-approval-probe.tsx\`: an <Approval> node (request title/summary) followed by a static Task that only mounts after approval (see the Approval docs pattern). Same mount caveat as t4: a stale gateway on 7342 must be restarted to pick the file up.
2. \`apps/smithers/tests/e2e-real/approval.spec.ts\`: launch e2e-approval-probe on the real gateway through the UI, assert the run pauses waiting-approval and the approval request surfaces in the UI, approve it FROM THE UI, then assert the run resumes and reaches finished with the gated task's output present.

Success criteria: the whole round-trip is driven through the real gateway RPC path (no direct DB pokes, no CLI approve in the spec), and the verify command exits 0.`,
  },
  {
    id: "t6-real-suite-green",
    title: "Full real suite + repo gates green in one shot",
    verifyCmd:
      "pnpm -C apps/smithers typecheck && pnpm -C apps/smithers test:unit && pnpm -C apps/smithers exec playwright test --config playwright.real.config.ts",
    verifyTimeoutMs: 60 * 60 * 1000,
    md: `Stabilization ticket — make the whole thing green in ONE command from a cold start:

- \`pnpm -C apps/smithers typecheck\` green.
- \`pnpm -C apps/smithers test:unit\` green (including any assumption tests you added).
- \`pnpm -C apps/smithers exec playwright test --config playwright.real.config.ts\` green — all e2e-real specs in one run, sharing one stack boot, no inter-spec interference (workers: 1 already; specs assert on their own runIds).
- Fix flakes by fixing root causes (readiness probes, generous-but-bounded timeouts), never by retry-spam or weakened assertions.
- Update apps/smithers docs (e.g. a docs/e2e-real.md or README section) describing: required secrets in .env.e2e.local (chat upstream: CEREBRAS_API_KEY or GEMINI_API_KEY), plue-up.sh usage, the port map, the 7342-vs-7331 gateway rule, and how to run the suite.
- Ensure every piece of this work is committed (atomic, emoji conventional commits). Do not push — the workflow pushes after this gate.

Success criteria: the verify command exits 0, run twice in a row (idempotency). git status shows no uncommitted files from this work.`,
  },
];

/** The ralph loop's gate is the full T6 command. */
const RALPH_GATE: Ticket = {
  id: "ralph",
  title: "Ralph quality loop full gate",
  md: "",
  verifyCmd: TICKETS[TICKETS.length - 1].verifyCmd,
  verifyTimeoutMs: 60 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// Compute implementations: preflight, env apply, verify, audit, push
// ---------------------------------------------------------------------------

async function runPreflight() {
  const fileEnv = readEnvFile();
  const has = (k: string) => Boolean(process.env[k] || fileEnv[k]);

  const docker = await sh("docker info >/dev/null 2>&1 && echo ok", { timeoutMs: 20_000 });
  const dockerOk = docker.exitCode === 0;
  const plueDirOk = existsSync(resolve(PLUE_DIR, "docker-compose.yml"));
  const claude = await sh("claude --version", { timeoutMs: 20_000 });
  const claudeCliOk = claude.exitCode === 0;

  // The e2e gateway and the planner/reviewer tasks spawn the HOST claude CLI
  // on the fable model, so prove that exact credential+model completes a
  // prompt (one tiny real call). Tokens from .env.e2e.local are honored.
  let claudeAuthOk = false;
  if (claudeCliOk) {
    // The inherited shell ANTHROPIC_API_KEY has no credits and flips the
    // claude CLI to API billing. Unset it (exactly what ClaudeCodeAgent does)
    // unless the operator explicitly supplied a key via the env file.
    const keyPrefix = fileEnv["ANTHROPIC_API_KEY"] ? "" : "unset ANTHROPIC_API_KEY; ";
    const probe = await sh(keyPrefix + 'claude -p "Say OK" --model claude-fable-5', {
      timeoutMs: 120_000,
      env: verifyEnv(),
    });
    claudeAuthOk = probe.exitCode === 0 && probe.tail.trim() !== "";
  }

  // Chat upstream: one real completion against the resolved provider
  // (Cerebras if its key exists, else Gemini Flash via the OpenAI-compatible
  // endpoint). Validates key + base URL + model id in one shot.
  const up = chatUpstream();
  let chatUpstreamOk = false;
  let chatProvider = "none";
  if (up) {
    chatProvider = `${up.provider}/${up.model}`;
    const body = JSON.stringify({ model: up.model, messages: [{ role: "user", content: "Say OK" }] });
    const curlCmd = `curl -fsS --max-time 45 "${up.baseUrl}/chat/completions" -H "Authorization: Bearer ${up.key}" -H "content-type: application/json" -d '${body}'`;
    let probe = await sh(curlCmd, { timeoutMs: 60_000 });
    chatUpstreamOk = probe.exitCode === 0 && probe.tail.includes('"choices"');
    if (!chatUpstreamOk) {
      // One retry: model endpoints throw transient 5xx under load.
      probe = await sh("sleep 5; " + curlCmd, { timeoutMs: 70_000 });
      chatUpstreamOk = probe.exitCode === 0 && probe.tail.includes('"choices"');
    }
    if (!chatUpstreamOk) chatProvider += ` (probe failed: ${tailOf(probe.tail, 300).replace(/\n/g, " ")})`;
  }

  // Codex: the operator wants Codex implementing. Probe a real one-liner on
  // ChatGPT auth (model from SMITHERS_E2E_CODEX_MODEL, default gpt-5.5 — the
  // -codex model names are rejected under ChatGPT auth). skipCodex=true from
  // the human falls back to Claude implementation.
  const codexSkipped = has("SMITHERS_E2E_SKIP_CODEX");
  let codexOk = false;
  if (!codexSkipped) {
    const cli = await sh("codex --version", { timeoutMs: 20_000 });
    if (cli.exitCode === 0) {
      const probe = await sh(`codex exec --skip-git-repo-check --model ${CODEX_MODEL} "Say OK"`, {
        timeoutMs: 180_000,
        env: verifyEnv(),
      });
      codexOk = probe.exitCode === 0 && probe.tail.trim() !== "";
    }
  }

  const missing: string[] = [];
  if (!dockerOk) missing.push("docker daemon is not running (start Docker Desktop)");
  if (!plueDirOk) missing.push(`plue checkout with docker-compose.yml not found at ${PLUE_DIR} (set PLUE_DIR)`);
  if (!claudeCliOk) missing.push("claude CLI not on PATH (the cwd gateway and planner tasks spawn it)");
  if (claudeCliOk && !claudeAuthOk)
    missing.push(
      "claude CLI cannot complete a prompt on claude-fable-5 — authenticate it (run `claude /login`, or `claude setup-token` and supply claudeOauthToken; the known ANTHROPIC_API_KEY has no credits)",
    );
  if (!chatUpstreamOk)
    missing.push(
      up
        ? `chat upstream probe failed for ${chatProvider} — fix the key/model or supply a different one (cerebrasApiKey or geminiApiKey)`
        : "no chat upstream key: supply geminiApiKey (aistudio.google.com, powers Gemini Flash) or cerebrasApiKey (cloud.cerebras.ai) for real /api/chat completions",
    );
  if (!codexSkipped && !codexOk)
    missing.push(
      `codex CLI cannot complete a prompt with model ${CODEX_MODEL} (ChatGPT auth) — run \`codex login\`, or answer skipCodex=true to fall back to Claude for implementation`,
    );

  return {
    ok: missing.length === 0,
    dockerOk,
    plueDirOk,
    claudeCliOk,
    claudeAuthOk,
    chatUpstreamOk,
    chatProvider,
    codexOk,
    codexSkipped,
    missing: missing.join("; ") || "none",
    detail: `env file: ${ENV_FILE} (${existsSync(ENV_FILE) ? "exists" : "absent"}); plue: ${PLUE_DIR}; chat: ${chatProvider}; codex: ${codexOk ? "ok" : codexSkipped ? "skipped by operator" : "unavailable"}`,
  };
}

function applyHumanEnv(fix: Record<string, unknown> | undefined) {
  const provided: Record<string, string> = {};
  const maybe = (key: string, envName: string) => {
    const v = fix?.[key];
    if (typeof v === "string" && v.trim() !== "") provided[envName] = v.trim();
  };
  maybe("cerebrasApiKey", "CEREBRAS_API_KEY");
  maybe("geminiApiKey", "GEMINI_API_KEY");
  maybe("claudeOauthToken", "CLAUDE_CODE_OAUTH_TOKEN");
  maybe("anthropicApiKey", "ANTHROPIC_API_KEY");
  if (fix?.skipCodex === true) provided["SMITHERS_E2E_SKIP_CODEX"] = "1";

  const existing = readEnvFile();
  const merged = { ...existing, ...provided };
  const body = Object.entries(merged)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  mkdirSync(dirname(ENV_FILE), { recursive: true });
  writeFileSync(ENV_FILE, body + "\n", "utf8");
  chmodSync(ENV_FILE, 0o600);

  // Keep the secret file out of git.
  const gi = resolve(REPO, "apps/smithers/.gitignore");
  const giBody = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (!giBody.includes(".env.e2e.local")) {
    writeFileSync(gi, giBody.replace(/\n*$/, "\n") + "\n# Real-stack e2e secrets (real-stack-e2e workflow)\n.env.e2e.local\n");
  }

  return {
    wrote: Object.keys(provided).length > 0,
    keysWritten: Object.keys(provided).join(",") || "none",
    path: ENV_FILE,
  };
}

function writeTickets() {
  mkdirSync(TICKET_DIR, { recursive: true });
  for (const t of TICKETS) {
    const body = `# ${t.id} — ${t.title}\n\n${t.md}\n\n## Verify command (must exit 0)\n\n\`\`\`bash\n${t.verifyCmd}\n\`\`\`\n`;
    writeFileSync(resolve(TICKET_DIR, `${t.id}.md`), body, "utf8");
  }
  return { count: TICKETS.length, dir: TICKET_DIR };
}

async function runVerify(t: Ticket) {
  const r = await sh(t.verifyCmd, { timeoutMs: t.verifyTimeoutMs, env: verifyEnv() });
  return {
    passed: r.exitCode === 0,
    exitCode: r.exitCode,
    command: t.verifyCmd,
    outputTail: r.tail,
    durationMs: r.durationMs,
  };
}

const FORBIDDEN_PATTERNS = [
  "page.route(",
  "routeWebSocket",
  "mockGateway",
  "tests/fixtures/",
  "cerebrasUpstream",
  "fakePlueHost",
  "gatewayFixture",
  "plueFixture",
  "authFixture",
];
const AUDIT_PATHS = [
  "apps/smithers/tests/e2e-real",
  "apps/smithers/playwright.real.config.ts",
  "scripts/e2e-real",
];
const PROTECTED_FILES = ["apps/smithers/playwright.config.ts", "apps/smithers/tests/e2e/", "apps/smithers/tests/fixtures/"];

async function runAudit() {
  const violations: string[] = [];

  const present = AUDIT_PATHS.filter((p) => existsSync(resolve(REPO, p)));
  if (present.length === 0) {
    return { clean: false, violations: "no e2e-real artifacts exist yet (expected at least one of: " + AUDIT_PATHS.join(", ") + ")" };
  }

  const patternArgs = FORBIDDEN_PATTERNS.map((p) => `-e ${JSON.stringify(p)}`).join(" ");
  const rg = await sh(`rg -nF --no-heading ${patternArgs} ${present.map((p) => JSON.stringify(p)).join(" ")}`, {
    timeoutMs: 60_000,
  });
  // rg: 0 = matches found (violations), 1 = clean, 2 = error
  if (rg.exitCode === 0) violations.push("forbidden mock/fixture references:\n" + tailOf(rg.tail, 3000));
  else if (rg.exitCode === 2) violations.push("audit grep errored:\n" + tailOf(rg.tail, 1000));

  const diff = await sh("git diff --name-only origin/main", { timeoutMs: 30_000 });
  if (diff.exitCode === 0) {
    const touched = diff.tail.split("\n").filter(Boolean);
    const bad = touched.filter((f) => PROTECTED_FILES.some((p) => f === p || f.startsWith(p)));
    if (bad.length > 0) violations.push("protected fixture-suite files modified: " + bad.join(", "));
  }

  const secretLeak = await sh(
    `git diff origin/main -- ${present.map((p) => JSON.stringify(p)).join(" ")} | rg -iF -e "csk-" -e "sk-ant-" -e "AIza" || true`,
    { timeoutMs: 30_000 },
  );
  if (secretLeak.tail.trim() !== "" && secretLeak.exitCode === 0) violations.push("possible secret committed in diff (csk-/sk-ant-/AIza prefix found)");

  return { clean: violations.length === 0, violations: violations.join("\n\n") || "none" };
}

async function pushMain() {
  const first = await sh("git push origin main", { timeoutMs: 120_000 });
  if (first.exitCode === 0) return { pushed: true, detail: tailOf(first.tail, 1000) };
  const second = await sh(
    "git -c rebase.autoStash=true pull --rebase origin main && git push origin main",
    { timeoutMs: 180_000 },
  );
  return { pushed: second.exitCode === 0, detail: tailOf(first.tail + "\n---\n" + second.tail, 2000) };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function implementPrompt(t: Ticket, feedback: string | null): string {
  return [
    `You are the implementation agent for ticket ${t.id} — "${t.title}" in the smithers repo. Earlier tickets in this run are already merged into the working tree; build on them.`,
    GROUND_RULES,
    `## Ticket\n${t.md}`,
    `## Verify command (the workflow runs this after you finish; it MUST exit 0)\n\`\`\`bash\n${t.verifyCmd}\n\`\`\``,
    feedback ? `## Feedback from the previous iteration — fix ALL of this first\n${feedback}` : "",
    OPS_NOTES,
    `When done, your structured output: summary (what you built and the evidence you saw), filesChanged (comma-separated paths), commits (the commit subjects you made), blocked=false. If you raised ask-human and got unblocked, mention it. If you are terminally blocked, set blocked=true with blockedReason.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function reviewPrompt(t: Ticket, verifyTail: string): string {
  return [
    `You are an independent reviewer for ticket ${t.id} — "${t.title}" in the smithers repo. The verify command already exited 0; your job is to catch cheating and quality problems the test cannot.`,
    `Review the working tree (git status, git log -10 --oneline, git diff origin/main -- relevant paths) against:`,
    `## Ticket\n${t.md}`,
    GROUND_RULES,
    `## Verify output (tail)\n\`\`\`\n${tailOf(verifyTail, 4000)}\n\`\`\``,
    `Reject if: any assertion was weakened or made vacuous (e.g. expect(true)); any mock/fixture/hardcoded-fallback sneaked in; the spec doesn't actually exercise the real backend it claims (read the spec code!); secrets ended up in tracked files; the fixture suite or unrelated files were modified; commits are missing/non-atomic/badly formatted. Approve only when the ticket's success criteria are genuinely met.`,
    `Output: approved (boolean) and feedback — when rejecting, give precise, actionable items.`,
  ].join("\n\n");
}

type RalphPrev = {
  planSummary: string | null;
  verifyPassed: boolean | null;
  verifyTail: string | null;
  reviewApproved: boolean | null;
  reviewFeedback: string | null;
};

function ralphPlanPrompt(iteration: number, prev: RalphPrev): string {
  const prevBlock =
    prev.planSummary === null
      ? "This is the first ralph iteration. The six base tickets (real stack boot, sign-in, chat LLM, gateway run, approval, full gate) are green and pushed."
      : [
          `## Previous iteration outcome`,
          `Plan was: ${prev.planSummary}`,
          prev.verifyPassed === false
            ? `VERIFY FAILED — the tree may be red. Your batch MUST start by fixing or reverting this:\n${tailOf(prev.verifyTail ?? "", 4000)}`
            : `Verify passed.`,
          prev.reviewApproved === false ? `Reviewer rejected with:\n${prev.reviewFeedback}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");

  return [
    `You are the PLANNER for iteration ${iteration + 1}/${RALPH_MAX_ITERATIONS} of the ralph quality loop on the smithers repo (focus: apps/smithers, plus scripts/e2e-real and the e2e-real suite).`,
    `Mission: continuously raise quality and test coverage with small, verifiable batches. Hunt for, in priority order:
1. anything left red or rejected from the previous iteration (always first);
2. missing e2e coverage — user-visible flows of apps/smithers that have NO spec in tests/e2e-real/ (real backends only; check what the fixture suite covers that the real suite does not, and which canvas/surfaces have zero coverage anywhere);
3. missing unit tests — exported functions/stores in apps/smithers/src with no bun test (look at src/**/*.ts without a sibling .test.ts, untested zustand store actions, worker routes);
4. code quality — dead code, duplicated logic, error paths that swallow failures, useState/useEffect violations of the repo style, type unsafety (any-casts), brittle selectors in specs.`,
    `Read the repo before planning: git log -15 --oneline, ls apps/smithers/tests/e2e-real, the coverage gaps above. Plan a batch of 1-3 items MAX, each small enough that implement+verify fits in one iteration. Every item needs a measurable acceptance check (a test that exists and passes, a command that exits 0).`,
    GROUND_RULES,
    prevBlock,
    `## Stop condition
Set done=true (with empty items) when the remaining work is genuinely low-value: the tree is green, the meaningful user flows have real e2e coverage, the obvious unit-test gaps are closed, and another iteration would be churn. Do NOT pad iterations to look busy.`,
    `Output: done (boolean), focus (one line: this iteration's theme), items (markdown list: each item = what to build/refactor + its acceptance check + exact file paths), rationale (why these are the highest-value items now).`,
  ].join("\n\n");
}

function ralphImplementPrompt(focus: string, items: string): string {
  return [
    `You are the IMPLEMENTATION agent for one iteration of the ralph quality loop in the smithers repo. The planner chose this batch — implement ALL of it.`,
    `## Focus\n${focus}`,
    `## Batch items (each has an acceptance check — make every one true)\n${items}`,
    GROUND_RULES,
    `## Gate (the workflow runs this after you finish; it MUST exit 0)\n\`\`\`bash\n${RALPH_GATE.verifyCmd}\n\`\`\`\nRun the relevant parts yourself before finishing. New unit tests run under \`pnpm -C apps/smithers test:unit\`; new e2e specs go in apps/smithers/tests/e2e-real/ and must pass against the real stack.`,
    OPS_NOTES,
    `When done, your structured output: summary, filesChanged (comma-separated), commits (subjects), blocked=false (or blocked=true + blockedReason).`,
  ].join("\n\n");
}

function ralphReviewPrompt(focus: string, items: string, verifyTail: string): string {
  return [
    `You are the independent REVIEWER for one ralph-loop iteration in the smithers repo. The full gate (typecheck + unit + real e2e suite) already exited 0. Catch what it cannot.`,
    `## The planned batch\nFocus: ${focus}\n${items}`,
    GROUND_RULES,
    `## Gate output (tail)\n\`\`\`\n${tailOf(verifyTail, 4000)}\n\`\`\``,
    `Check the diff (git log -10 --oneline, git diff origin/main): every batch item actually delivered with its acceptance check genuinely met; new tests assert real behavior (would they fail if the feature broke?); no weakened/vacuous assertions; no mocks/fixtures in e2e-real; no fixture-suite or unrelated-file modifications; commits atomic and well-formed; no secrets.`,
    `Output: approved (boolean) and feedback — when rejecting, give precise, actionable items the next iteration must fix.`,
  ].join("\n\n");
}

function reportPrompt(): string {
  return [
    `The real-stack-e2e run is complete: six base tickets green, ralph quality loop finished, work pushed. Write the evidence report.`,
    `Create artifacts/real-stack-e2e/report.md in the smithers repo (${REPO}) containing: what shipped (files, specs, compose usage), the ralph-loop iterations (read .smithers/tickets/real-stack-e2e/ and git log for what each added), the exact commands to boot the stack and run the suite, the port map, required secrets (NAMES only, never values: chat upstream = CEREBRAS_API_KEY or GEMINI_API_KEY), evidence (rerun "pnpm -C apps/smithers exec playwright test --config playwright.real.config.ts --list" to enumerate specs), remaining risks/flakes, and follow-ups. Commit it (emoji conventional commit, Co-Authored-By trailer) and push to origin main.`,
    `Output: path (the report path) and summary (5-10 line plain-English summary for the human).`,
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: z.object({ goal: z.string().nullish() }),
  preflight: z.object({
    ok: z.boolean(),
    dockerOk: z.boolean(),
    plueDirOk: z.boolean(),
    claudeCliOk: z.boolean(),
    claudeAuthOk: z.boolean(),
    chatUpstreamOk: z.boolean(),
    chatProvider: z.string(),
    codexOk: z.boolean(),
    codexSkipped: z.boolean(),
    missing: z.string(),
    detail: z.string(),
  }),
  humanEnv: z.object({
    cerebrasApiKey: z.string().nullable(),
    geminiApiKey: z.string().nullable(),
    claudeOauthToken: z.string().nullable(),
    anthropicApiKey: z.string().nullable(),
    skipCodex: z.boolean().nullable(),
    note: z.string().nullable(),
  }),
  envApply: z.object({ wrote: z.boolean(), keysWritten: z.string(), path: z.string() }),
  ticketsFile: z.object({ count: z.number(), dir: z.string() }),
  implement: z.object({
    summary: z.string(),
    filesChanged: z.string(),
    commits: z.string(),
    blocked: z.boolean(),
    blockedReason: z.string().nullable(),
  }),
  verify: z.object({
    passed: z.boolean(),
    exitCode: z.number(),
    command: z.string(),
    outputTail: z.string(),
    durationMs: z.number(),
  }),
  audit: z.object({ clean: z.boolean(), violations: z.string() }),
  review: z.object({ approved: z.boolean(), feedback: z.string() }),
  ralphPlan: z.object({
    done: z.boolean(),
    focus: z.string(),
    items: z.string(),
    rationale: z.string(),
  }),
  push: z.object({ pushed: z.boolean(), detail: z.string() }),
  report: z.object({ path: z.string(), summary: z.string() }),
});

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export default smithers((ctx) => {
  // ---- preflight state ----
  const pf = ctx.latest("preflight", "preflight:probe") as
    | { ok?: boolean | number; missing?: string; detail?: string; codexOk?: boolean | number }
    | undefined;
  const preflightOk = Boolean(pf?.ok);
  const preflightBad = pf !== undefined && !pf.ok;
  const codexAvailable = Boolean(pf?.codexOk);
  const impl = implementers(codexAvailable);

  // ---- per-ticket state ----
  const ticketState = (t: Ticket) => {
    const verify = ctx.latest("verify", `${t.id}:verify`) as
      | { passed?: boolean | number; outputTail?: string; exitCode?: number }
      | undefined;
    const audit = ctx.latest("audit", `${t.id}:audit`) as
      | { clean?: boolean | number; violations?: string }
      | undefined;
    const review = ctx.latest("review", `${t.id}:review`) as
      | { approved?: boolean | number; feedback?: string }
      | undefined;
    const passed = Boolean(verify?.passed);
    const clean = Boolean(audit?.clean);
    const approved = Boolean(review?.approved);

    const feedbackParts: string[] = [];
    if (verify && !passed) {
      feedbackParts.push(
        `VERIFY FAILED (exit ${verify.exitCode}). Command: ${t.verifyCmd}\nOutput tail:\n${tailOf(verify.outputTail ?? "", 5000)}`,
      );
    }
    if (audit && !clean) feedbackParts.push(`NO-MOCK AUDIT FAILED:\n${audit.violations}`);
    if (review && !approved && review.feedback) feedbackParts.push(`REVIEWER REJECTED:\n${review.feedback}`);

    return {
      verify,
      done: passed && clean && approved,
      passed,
      clean,
      feedback: feedbackParts.length > 0 ? feedbackParts.join("\n\n") : null,
    };
  };

  // ---- ralph state ----
  const ralphPlan = ctx.latest("ralphPlan", "ralph:plan") as
    | { done?: boolean | number; focus?: string; items?: string; rationale?: string }
    | undefined;
  const ralphIter = ctx.iterationCount("ralphPlan", "ralph:plan");
  const ralphDone = Boolean(ralphPlan?.done);
  const rVerify = ctx.latest("verify", "ralph:verify") as
    | { passed?: boolean | number; outputTail?: string }
    | undefined;
  const rAudit = ctx.latest("audit", "ralph:audit") as { clean?: boolean | number } | undefined;
  const rReview = ctx.latest("review", "ralph:review") as
    | { approved?: boolean | number; feedback?: string }
    | undefined;
  const rPassed = Boolean(rVerify?.passed);
  const rClean = Boolean(rAudit?.clean);
  const rApproved = Boolean(rReview?.approved);
  const ralphPrev: RalphPrev = {
    planSummary: ralphPlan ? `${ralphPlan.focus ?? ""} — ${tailOf(ralphPlan.items ?? "", 1500)}` : null,
    verifyPassed: rVerify ? rPassed : null,
    verifyTail: rVerify?.outputTail ?? null,
    reviewApproved: rReview ? rApproved : null,
    reviewFeedback: rReview?.feedback ?? null,
  };

  return (
    <Workflow name="real-stack-e2e">
      {/* Phase 1: environment backpressure — block on the human until everything real is available. */}
      <Loop id="preflight-loop" until={preflightOk} maxIterations={8} onMaxReached="fail">
        <Sequence>
          <Task id="preflight:probe" output={outputs.preflight} noRetry timeoutMs={420_000}>
            {() => runPreflight()}
          </Task>
          {preflightBad ? (
            <>
              <HumanTask
                id="preflight:fix"
                output={outputs.humanEnv}
                maxAttempts={10}
                prompt={`The real-stack-e2e run is blocked on missing prerequisites:\n\n  ${pf?.missing}\n\n(${pf?.detail})\n\nPlease answer with JSON: {"cerebrasApiKey": string|null, "geminiApiKey": string|null, "claudeOauthToken": string|null, "anthropicApiKey": string|null, "skipCodex": boolean|null, "note": string|null}.\n- geminiApiKey: from https://aistudio.google.com — powers real /api/chat via Gemini Flash until Cerebras is set up.\n- cerebrasApiKey: from https://cloud.cerebras.ai — takes precedence over Gemini once supplied.\n- claudeOauthToken: ONLY if the claude auth probe failed — run \`claude setup-token\` and paste, or fix out-of-band with \`claude /login\` and answer null.\n- skipCodex: true = stop requiring codex and fall back to Claude for implementation.\n- Provide null for anything you fixed out-of-band (e.g. ran \`codex login\` yourself) and say so in note.\nValues are written only to ${ENV_FILE} (gitignored, chmod 600).`}
              />
              <Task
                id="preflight:apply"
                output={outputs.envApply}
                noRetry
                deps={{ "preflight:fix": outputs.humanEnv }}
              >
                {(deps: Record<string, unknown>) =>
                  applyHumanEnv(deps["preflight:fix"] as Record<string, unknown>)
                }
              </Task>
            </>
          ) : null}
        </Sequence>
      </Loop>

      {/* Phase 2: persist the ticket definitions for humans + future agents. */}
      <Task id="tickets:write" output={outputs.ticketsFile} noRetry>
        {() => writeTickets()}
      </Task>

      {/* Phase 3: sequential ticket pipelines, each with hard backpressure. */}
      <Sequence>
        {TICKETS.map((t) => {
          const s = ticketState(t);
          return (
            <Loop key={t.id} id={`${t.id}:loop`} until={s.done} maxIterations={5} onMaxReached="fail">
              <Sequence>
                <Task
                  id={`${t.id}:implement`}
                  output={outputs.implement}
                  agent={impl}
                  retries={2}
                  timeoutMs={90 * 60 * 1000}
                  heartbeatTimeoutMs={90 * 60 * 1000}
                >
                  {implementPrompt(t, s.feedback)}
                </Task>
                <Task
                  id={`${t.id}:verify`}
                  output={outputs.verify}
                  noRetry
                  timeoutMs={t.verifyTimeoutMs + 60_000}
                  heartbeatTimeoutMs={t.verifyTimeoutMs + 60_000}
                >
                  {() => runVerify(t)}
                </Task>
                <Task id={`${t.id}:audit`} output={outputs.audit} noRetry timeoutMs={5 * 60 * 1000}>
                  {() => runAudit()}
                </Task>
                {s.passed && s.clean ? (
                  <Task
                    id={`${t.id}:review`}
                    output={outputs.review}
                    agent={planners}
                    retries={2}
                    timeoutMs={30 * 60 * 1000}
                    heartbeatTimeoutMs={30 * 60 * 1000}
                  >
                    {reviewPrompt(t, s.verify?.outputTail ?? "")}
                  </Task>
                ) : null}
              </Sequence>
            </Loop>
          );
        })}
      </Sequence>

      {/* Phase 3.5: push the green base suite before the long ralph phase. */}
      <Task id="base:push" output={outputs.push} noRetry timeoutMs={5 * 60 * 1000}>
        {() => pushMain()}
      </Task>

      {/* Phase 4: ralph quality loop — Fable plans, Codex implements, full gate
          verifies, Fable reviews, every approved iteration pushes. */}
      <Loop
        id="ralph:loop"
        until={ralphDone}
        maxIterations={RALPH_MAX_ITERATIONS}
        onMaxReached="return-last"
      >
        <Sequence>
          <Task
            id="ralph:plan"
            output={outputs.ralphPlan}
            agent={planners}
            retries={2}
            timeoutMs={45 * 60 * 1000}
            heartbeatTimeoutMs={45 * 60 * 1000}
          >
            {ralphPlanPrompt(ralphIter, ralphPrev)}
          </Task>
          {!ralphDone ? (
            <>
              <Task
                id="ralph:implement"
                output={outputs.implement}
                agent={impl}
                retries={2}
                timeoutMs={90 * 60 * 1000}
                heartbeatTimeoutMs={90 * 60 * 1000}
              >
                {ralphImplementPrompt(ralphPlan?.focus ?? "", ralphPlan?.items ?? "")}
              </Task>
              <Task
                id="ralph:verify"
                output={outputs.verify}
                noRetry
                timeoutMs={RALPH_GATE.verifyTimeoutMs + 60_000}
                heartbeatTimeoutMs={RALPH_GATE.verifyTimeoutMs + 60_000}
              >
                {() => runVerify(RALPH_GATE)}
              </Task>
              <Task id="ralph:audit" output={outputs.audit} noRetry timeoutMs={5 * 60 * 1000}>
                {() => runAudit()}
              </Task>
              {rPassed && rClean ? (
                <Task
                  id="ralph:review"
                  output={outputs.review}
                  agent={planners}
                  retries={2}
                  timeoutMs={30 * 60 * 1000}
                  heartbeatTimeoutMs={30 * 60 * 1000}
                >
                  {ralphReviewPrompt(ralphPlan?.focus ?? "", ralphPlan?.items ?? "", rVerify?.outputTail ?? "")}
                </Task>
              ) : null}
              {rPassed && rClean && rApproved ? (
                <Task id="ralph:push" output={outputs.push} noRetry timeoutMs={5 * 60 * 1000}>
                  {() => pushMain()}
                </Task>
              ) : null}
            </>
          ) : null}
        </Sequence>
      </Loop>

      {/* Phase 5: final push for any remainder, then the evidence report. */}
      <Task id="finalize:push" output={outputs.push} noRetry timeoutMs={5 * 60 * 1000}>
        {() => pushMain()}
      </Task>
      <Task
        id="finalize:report"
        output={outputs.report}
        agent={planners}
        retries={2}
        timeoutMs={30 * 60 * 1000}
        heartbeatTimeoutMs={30 * 60 * 1000}
      >
        {reportPrompt()}
      </Task>
    </Workflow>
  );
});

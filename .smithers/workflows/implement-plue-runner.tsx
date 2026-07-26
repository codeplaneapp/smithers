// smithers-source: authored
// smithers-display-name: Implement Plue Runner
//
// The IMPLEMENTATION workflow for the "run any smithers script on plue infra"
// feature. This is deliberately a different workflow from the deliverable
// (`run-on-plue.tsx`, which this workflow builds): this one plans nothing and
// runs four milestone ValidationLoops (implement → validate → review panel)
// against the spec at .smithers/specs/run-on-plue.md.
//
//   M1  smithers:  plue SandboxProvider + run-on-plue workflow + demo child
//   M2  plue:      CLI `workspace exec` + codex auth seeding + dispatch fix
//   M3  plue:      npm package `plue` (bin `plue`) + Go CLI repo extraction
//   M4  both:      docs + llms bundle regeneration
//
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { implementer, panelists } from "../components/roles";
import {
  ValidationLoop,
  implementOutputSchema,
  validateOutputSchema,
  validationLoopState,
} from "../components/ValidationLoop";
import { reviewOutputSchema, reviewSynthesisSchema } from "../components/Review";

const SPEC = ".smithers/specs/run-on-plue.md";
const SMITHERS_REPO = ".";
const PLUE_REPO = "../plue";

const summarySchema = z.object({
  summary: z.string(),
  artifacts: z.array(z.string()).default([]),
  followUps: z.array(z.string()).default([]),
});
const failureSchema = z.object({ error: z.string() });
const milestoneCompleteSchema = z.object({ milestone: z.string() });

export const inputSchema = z.object({
  plueCliBin: z.string().trim().min(1).max(4_096).default("plue"),
  maxIterations: z.number().int().min(1).max(10).default(3),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
  reviewSynthesis: reviewSynthesisSchema,
  summary: summarySchema,
  failure: failureSchema,
  milestoneComplete: milestoneCompleteSchema,
});

const SHARED_CONTEXT = `
CONTEXT YOU MUST LOAD FIRST:
- Read the spec: ${SPEC}; its architecture decisions are the ground truth.
- The two repos: smithers-orchestrator at ${SMITHERS_REPO} (jj colocated repo;
  see its CLAUDE.md), plue at ${PLUE_REPO} (Go monorepo, jj-native product).

EXECUTION ENVIRONMENT:
- No live Plue service, authenticated account, workspace, token, or local agent
  credential is assumed. Verify each prerequisite before any integration check.
- Use operator-provided fixtures or existing workspaces where available. Never
  create billable infrastructure merely to satisfy this workflow.
- NEVER print, log, or commit secret values; never bake them into snapshots or
  committed files.

HOUSE RULES (both repos):
- No mocks in product code or e2e paths. Unit tests of pure functions are
  fine; fabricating backend responses is not.
- Emoji + Conventional Commit messages; commit with EXPLICIT pathspecs (the
  trees are shared with concurrent agents — never \`git add -A\`). Commit your
  milestone's work when your validation passes. Do NOT push.
- If blocked on a decision only a human can make, run
  \`smithers ask-human "<question>"\` and wait; do not guess.
`;

const M1_PROMPT = `${SHARED_CONTEXT}
MILESTONE 1 — smithers: the plue sandbox provider and the runner workflow.

Work in ${SMITHERS_REPO}. Deliverables:

1. \`.smithers/lib/plue-provider.ts\` — export \`createPlueSandboxProvider(options)\`
   returning a \`SandboxProvider\` (type from "smithers-orchestrator/sandbox";
   see packages/sandbox/src/SandboxProvider.ts). Options (all overridable):
   { plueBin (default: env PLUE_BIN or "plue"), repo (required, "owner/repo"),
     workspaceName?, keepWorkspace? (default false),
     orchestratorVersion (default "0.26.1"), bootstrapAgents (default true),
     env? (extra env for the remote run) }.
   Provider behavior in run(request):
   a. \`<plueBin> workspace create --repo <repo> --name <sanitized unique name>
      --format json\` via execFile (NEVER shell string interpolation of
      user-controlled values).
   b. Poll \`workspace view <id> --repo <repo> --format json\` until
      status==="running" and .ssh.command is present (timeout ~6 min, poll
      every 5s, call request.heartbeat({stage, ...}) as you go — never include
      tokens in heartbeat payloads).
   c. Parse the ssh command into a target; run every remote step with
      ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new.
   d. Bootstrap (idempotent; skip work already done since workspaces persist):
      install bun (official installer) if missing; install the claude CLI
      (@anthropic-ai/claude-code) and codex CLI (@openai/codex) globally if
      missing (bun i -g into ~/.bun works for the non-root "developer" user —
      verify empirically on the live VM and adjust). Verify with
      \`claude --version\` and \`codex --version\` over SSH.
   e. Ship a self-contained mini-project to the VM (base64 tar over ssh stdin
      is fine): package.json (deps: smithers-orchestrator@<orchestratorVersion>,
      zod), an agents.ts defining a ClaudeCodeAgent and a CodexAgent that
      authenticate from env only, the child script verbatim as script.tsx, and
      input.json from request.input.childInput.
   f. Write remote env (ANTHROPIC_API_KEY, OPENAI_API_KEY, plus options.env)
      to a 0600 file consumed by the run and deleted afterwards; never echo it.
   g. Run the child: bun install, then execute script.tsx with
      smithers-orchestrator's CLI (\`bunx --bun smithers-orchestrator@<v> up
      script.tsx --input "$(cat input.json)"\` or the mechanism you verify
      works — check \`bunx smithers-orchestrator up --help\` locally first).
      Capture the child run's final status and outputs (e.g. via the
      orchestrator's inspect/ps JSON surface in the VM after up returns) and
      map them into the inline SandboxProviderResult shape
      {status:"finished"|"failed", output, remoteRunId, workspaceId}. A failed
      remote run must return status:"failed" with the log tail in output.
   h. cleanup(): delete the workspace unless keepWorkspace.
   The module must have NO side effects at import time (no CLI probing, no
   child_process at module scope) so graph rendering works on machines
   without plue.
2. \`.smithers/workflows/run-on-plue.tsx\` — the deliverable runner workflow.
   Input schema: { script: string (path to any smithers workflow .tsx),
   input?: unknown, repo: string, keepWorkspace?: boolean, plueBin?: string }.
   It reads the script source from disk, renders
   <Sandbox id="plue-run" provider={createPlueSandboxProvider(...)}
     input={{ scriptSource, scriptName, childInput }} reviewDiffs={false}
     output={...}> with a typed output schema {status, output, remoteRunId,
   workspaceId} and a generous timeoutMs (>= 30 min). reviewDiffs MUST be
   false (default fails closed for unattended runs). Remember ctx.input fields
   arrive raw-or-null — coalesce defaults.
3. \`.smithers/workflows/plue-demo-child.tsx\` — a tiny SELF-CONTAINED demo
   child workflow (no ../agents import; defines a Codex 5.6 Luna medium chain
   inline with Claude only as sequential fallback): two trivial sequential
   Tasks with small typed outputs. A healthy Codex account must complete both
   without invoking Claude. This is the script the e2e verification runs.
4. Unit tests (bun test) for the provider's pure pieces: ssh-command parsing,
   result mapping, remote-script construction, name sanitization. Put them
   next to the provider (.smithers/lib/plue-provider.test.ts). No fabricated
   CLI transcripts pretending to be e2e — pure-function tests only.

VALIDATION (what the validate step will re-run — make these pass):
- cd ${SMITHERS_REPO}/.smithers && bun test lib/plue-provider.test.ts
- cd ${SMITHERS_REPO} && bunx smithers-orchestrator graph
  .smithers/workflows/run-on-plue.tsx exits 0, and the same for
  .smithers/workflows/plue-demo-child.tsx
- bunx tsc --noEmit -p ${SMITHERS_REPO}/.smithers/tsconfig.json exits 0
- OPTIONAL: when the operator has supplied an existing workspace, exercise
  provider steps a-d against it (SSH round-trip, bootstrap idempotence, and
  agent CLI version checks). Otherwise report the integration check as skipped.
Commit (explicit pathspecs): the three new files + tests, message like
"✨ feat(smithers-pack): plue sandbox provider + run-on-plue workflow".`;

const M2_PROMPT = `${SHARED_CONTEXT}
MILESTONE 2 — plue: non-interactive workspace exec, codex auth seeding, and
the broken workflow-sandbox dispatch fix.

Work in ${PLUE_REPO}. Deliverables:

1. \`smithers workspace exec\` command in internal/smitherscli
   (commands_workspace.go): positional workspace id (auto-detect like other
   workspace commands), --repo, --command (required), optional --timeout
   seconds. Resolves SSH info via the existing waitForWorkspaceSSHInfo
   helper, runs the command non-interactively (BatchMode, known-hosts file
   handling consistent with workspaceKnownHostsFile()), streams remote
   stdout/stderr through, and exits with the remote exit code. Reuse the
   existing runRemoteCaptureCommand/runRemoteInteractiveCommand plumbing
   where it fits. Add table-driven unit tests alongside the existing
   *_test.go files for the pure parts (arg validation, ssh invocation
   construction).
2. Codex auth seeding parity with the existing Claude plumbing: a helper that
   reads ~/.codex/auth.json (and OPENAI_API_KEY) locally and produces a
   remote seed script writing ~/.codex/auth.json (0600) on the VM — mirror
   buildClaudeAuthSeedRemoteScript/getClaudeAuthEnv in
   commands_workspace.go. Wire it so \`workspace exec\` (or a
   --seed-agent-auth flag on it) can seed both claude and codex auth before
   running a command. Tests for the script-builder (no secrets in test
   fixtures — use fakes with obvious placeholder values).
3. Fix the broken workflow-sandbox dispatch at the source: in
   internal/services/workflow_sandbox_scheduler.go buildWorkflowCommand
   (~line 610), \`bun x --package smithers-orchestrator smithers run <path>\`
   invokes a command that does not exist in current smithers-orchestrator
   (>=0.26 has \`up\`, not \`run\`). Change it to \`up\` with the equivalent
   flags (verify the current orchestrator CLI surface with
   \`bunx smithers-orchestrator@0.26.1 up --help\` / \`--help\`), and PIN the
   orchestrator version in that command instead of resolving latest at VM
   boot. Update any tests asserting the old command string. Also bump the
   stale "smithers-orchestrator": "^0.9.1" in cmd/runner/workflow/package.json
   to the pinned current version IF the runner workflow code still compiles
   against it — if the 0.9→0.26 API breaks that runtime, leave the bump out,
   note it in your summary, and only fix the scheduler command.

VALIDATION (make these pass):
- cd ${PLUE_REPO} && go build ./...
- go test ./internal/smitherscli/ -count=1
- go test ./internal/services/ -run 'WorkflowCommand|WorkflowSandbox' -count=1
  (scope to what runs without external services; if a needed test requires
  postgres, guard or scope accordingly and say so)
- Optional real check: when the operator supplies a workspace and repository,
  run \`go run ./cmd/smithers workspace exec <id> --repo <owner/repo>
  --command 'echo exec-works && node --version'\` and include the output. If no
  workspace is available, report the check as skipped rather than inventing it.
Commit per logical change with explicit pathspecs (e.g.
"✨ feat(cli): workspace exec + codex auth seeding",
"🐛 fix(workflows): dispatch smithers up instead of removed run command").`;

const M3_PROMPT = `${SHARED_CONTEXT}
MILESTONE 3 — plue: publishable npm CLI package \`plue\` + standalone repo
extraction for the Go CLI.

Work in ${PLUE_REPO}. Naming decision (final, from the spec): npm package
\`plue\`, bin \`plue\` — verified available on npm; avoids colliding with
smithers-orchestrator's \`smithers\` bin. Deliverables:

1. Rework packages/npm-cli into the \`plue\` package: name "plue", bin
   { "plue": "bin/plue.js" }, version 0.1.0, description/README (the README
   must explain: what plue/Smithers-cloud is, install via npm/bunx, auth
   login, workspace create/exec, and using it as the backend for
   smithers-orchestrator's run-on-plue workflow). Keep the
   download-vendored-binary postinstall pattern but make the release base URL
   configurable with a sane default pointing at the standalone repo's GitHub
   releases (env PLUE_RELEASE_BASE_URL override; SMITHERS_CLI_SKIP_DOWNLOAD
   equivalent becomes PLUE_CLI_SKIP_DOWNLOAD, keep the old var as a
   fallback). The wrapper must also fall back to a locally built binary
   (vendor/ or PLUE_CLI_BIN env) so \`npm pack\` + local install works fully
   offline in tests. The CLI's compiled-in default API URL is a DEAD domain
   (https://api.smithers.sh); make the wrapper/README point users at
   https://api.jjhub.tech (live today) or their self-hosted URL — if a
   one-line Go change to the default (internal/smitherscli/config.go:12) is
   the cleaner fix, make it and note it.
2. Replace the stale scripts/extract-cli-repo.ts (it targets a long-removed
   Rust cli/ dir) with a working Go extraction: emit to an output dir a
   standalone repo containing cmd main.go + the smitherscli package (module
   path github.com/roninjin10/plue-cli or a --module flag), a fresh go.mod
   with only the needed deps (internal/smitherscli imports no other
   repo-internal packages — verified), the npm wrapper package, a GitHub
   Actions release workflow that cross-compiles (darwin/linux × amd64/arm64)
   and uploads archives + SHA256SUMS to the release, and the README. The
   extracted repo must build: the script should run \`go build ./...\` inside
   the output dir and fail loudly if that fails.
3. A release helper (script or docs) covering: extract → create GitHub repo →
   tag → release binaries → npm publish. Do NOT publish and do NOT create
   the GitHub repo — the operator does that after verification (npm login is
   not available to you). \`npm publish --dry-run\` from the reworked package
   (with a locally built vendored binary) must succeed; include its output
   summary in your implement summary.

VALIDATION (make these pass):
- bun scripts/extract-cli-repo.ts /tmp/plue-cli-extract && (cd
  /tmp/plue-cli-extract && go build ./...)
- cd ${PLUE_REPO}/packages/npm-cli && npm pack --dry-run succeeds; with a
  locally built binary placed per your fallback mechanism,
  \`node bin/plue.js --version\` prints the CLI version
- npm publish --dry-run succeeds (no credentials needed for dry-run)
Commit with explicit pathspecs, e.g. "✨ feat(npm-cli): publishable plue
package" and "♻️ refactor(scripts): Go CLI standalone-repo extraction".`;

const M4_PROMPT = `${SHARED_CONTEXT}
MILESTONE 4 — docs, both repos.

1. In ${SMITHERS_REPO}: add a docs page under docs/ documenting the plue
   sandbox provider and the run-on-plue workflow (what it does, requirements
   — plue CLI installed+authed, workspaces feature flag, env keys — usage
   examples, the non-interactive/reviewDiffs=false caveat, and the
   claude+codex bootstrap behavior). Follow the existing docs structure (look
   at neighboring pages for frontmatter/format). Then regenerate the LLM
   bundles: pnpm docs:llms, and make pnpm check:docs && pnpm check:llms pass.
2. In ${PLUE_REPO}: document \`workspace exec\`, codex auth seeding, and the
   npm \`plue\` package + extraction/release flow wherever CLI docs live in
   that repo (grep for where existing workspace commands are documented; add
   alongside).

VALIDATION:
- cd ${SMITHERS_REPO} && pnpm check:docs && pnpm check:llms
- Docs build/lint for plue if such a gate exists (best-effort; note what you
  ran).
Commit docs with explicit pathspecs ("📝 docs: plue runner + provider docs",
one commit per repo).`;

function milestoneState(ctx: Parameters<Parameters<typeof smithers>[0]>[0], prefix: string, maxIterations: number) {
  return validationLoopState(ctx, { prefix, maxIterations });
}

export default smithers((ctx) => {
  const plueCliBin = ctx.input?.plueCliBin ?? "plue";
  const maxIterations = ctx.input?.maxIterations ?? 3;
  const withBin = (prompt: string) =>
    `${prompt}\n\nPLUE CLI COMMAND: ${plueCliBin}. Verify it is available and authenticated before any external check.`;

  const milestones = [
    { prefix: "m1", prompt: M1_PROMPT },
    { prefix: "m2", prompt: M2_PROMPT },
    { prefix: "m3", prompt: M3_PROMPT },
    { prefix: "m4", prompt: M4_PROMPT },
  ].map((milestone) => ({
    ...milestone,
    state: milestoneState(ctx, milestone.prefix, maxIterations),
  }));
  const allDone = milestones.every(({ state }) => state.done);

  const summaryPrompt = `All four milestones of the plue-runner build have run
  (see the spec at ${SPEC}). Milestone states: ${milestones.map(({ prefix, state }) => `${prefix} done=${state.done}`).join(", ")}. Inspect both repos'
working trees and recent commits (jj log in each) and produce: a summary of
what was built, the list of artifact paths (files created/changed, both
repos), and concrete followUps for anything not finished (including the
operator-only steps: gh repo creation, npm login + publish, e2e run of
run-on-plue with the demo child).`;

  return (
    <Workflow name="implement-plue-runner">
      <Sequence>
        {milestones.map(({ prefix, prompt, state }, index) => {
          const previousComplete = index > 0 ? `${milestones[index - 1]!.prefix}:complete` : undefined;
          return (
            <Sequence key={prefix}>
              <ValidationLoop
                idPrefix={prefix}
                prompt={withBin(prompt)}
                implementAgents={implementer}
                validateAgents={agents.midTier}
                reviewAgents={panelists}
                synthesizeReview
                startAfter={previousComplete ? [previousComplete] : undefined}
                reviewWhen={state.validationPassed}
                feedback={state.feedback}
                done={state.done}
                maxIterations={maxIterations}
              />
              {state.done ? (
                <Task id={`${prefix}:complete`} output={outputs.milestoneComplete} retries={0}>
                  {() => ({ milestone: prefix })}
                </Task>
              ) : null}
              {state.exhausted ? (
                <Task id={`${prefix}:exhausted`} output={outputs.failure} retries={0}>
                  {() => {
                    throw new Error(`Implement Plue Runner exhausted ${prefix} after ${maxIterations} attempts`);
                  }}
                </Task>
              ) : null}
            </Sequence>
          );
        })}
        {allDone ? (
          <Task
            id="final-summary"
            output={summarySchema}
            agent={agents.orchestrator}
            dependsOn={["m4:complete"]}
            timeoutMs={900_000}
          >
            {summaryPrompt}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});

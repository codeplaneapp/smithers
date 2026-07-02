// smithers-source: authored
// smithers-display-name: Implement Plue Runner
//
// The IMPLEMENTATION workflow for the "run any smithers script on plue infra"
// feature. This is deliberately a different workflow from the deliverable
// (`run-on-plue.tsx`, which this workflow builds): this one plans nothing and
// runs four milestone ValidationLoops (implement → validate → review panel)
// against the spec at .smithers/specs/run-on-plue.md.
//
//   M1  smithers4: plue SandboxProvider + run-on-plue workflow + demo child
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
} from "../components/ValidationLoop";
import {
  reviewOutputSchema,
  reviewSynthesisSchema,
  reviewGate,
} from "../components/Review";

const SPEC = "/Users/williamcory/smithers4/.smithers/specs/run-on-plue.md";
const SMITHERS_REPO = "/Users/williamcory/smithers4";
const PLUE_REPO = "/Users/williamcory/plue";

const summarySchema = z.object({
  summary: z.string(),
  artifacts: z.array(z.string()).default([]),
  followUps: z.array(z.string()).default([]),
});

const inputSchema = z.object({
  plueCliBin: z
    .string()
    .default(
      "/private/tmp/claude-501/-Users-williamcory-smithers4/5e1a1e3e-e382-404c-a23e-a83354f8cb59/scratchpad/plue-smithers",
    ),
});

const { Workflow, Task, Sequence, smithers } = createSmithers({
  input: inputSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
  reviewSynthesis: reviewSynthesisSchema,
  summary: summarySchema,
});

const SHARED_CONTEXT = `
CONTEXT YOU MUST LOAD FIRST:
- Read the spec: ${SPEC} (ground truth, verified 2026-07-01; includes the
  post-research adjustments section — the architecture decisions there are
  FINAL for this build).
- The two repos: smithers-orchestrator at ${SMITHERS_REPO} (jj colocated repo;
  see its CLAUDE.md), plue at ${PLUE_REPO} (Go monorepo, jj-native product).

LIVE INFRA AVAILABLE TO YOU (real, no mocks — use it to verify your work):
- plue dev stack is running: API http://localhost:4000 (readyz is green),
  seeded user alice, token smithers_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef.
- A built plue CLI binary (already logged in as alice against localhost) is
  available; its path arrives in the milestone prompt. \`workspace\` and
  \`repo\` commands work for real: repo alice/smoke-test exists, and workspace
  de356d2c-a67a-4bc1-b834-7f0f9505b764 (repo alice/smoke-test) is a RUNNING
  real Freestyle VM. Mint SSH via \`<cli> workspace view <id> --repo
  alice/smoke-test --format json\` (the .ssh.command field), then run
  commands non-interactively with
  \`ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new <target> '<cmd>'\`.
  Verified from inside that VM: node/git/jj present, bun ABSENT, egress to
  api.anthropic.com and api.openai.com OPEN. Creating VMs costs real money —
  prefer reusing that workspace for experiments; delete any extra ones you
  create.
- ANTHROPIC_API_KEY, OPENAI_API_KEY, FREESTYLE_API_KEY are set in the
  environment. ~/.codex/auth.json exists on this host. NEVER print, log, or
  commit secret values; never bake them into snapshots or committed files.

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
MILESTONE 1 — smithers4: the plue sandbox provider and the runner workflow.

Work in ${SMITHERS_REPO}. Deliverables:

1. \`.smithers/lib/plue-provider.ts\` — export \`createPlueSandboxProvider(options)\`
   returning a \`SandboxProvider\` (type from "smithers-orchestrator/sandbox";
   see packages/sandbox/src/SandboxProvider.ts and the shape of
   examples/freestyle/provider.ts). Options (all overridable):
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
   child workflow (no ../agents import; defines its own ClaudeCodeAgent and
   CodexAgent inline, env-authenticated): two sequential Tasks with small
   typed outputs — one answered by claude, one by codex (trivial questions,
   minimal tokens). This is the script the e2e verification will run on plue.
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
- OPTIONAL but strongly encouraged: exercise provider steps a-d for real
  against the live workspace listed above (SSH round-trip, bootstrap
  idempotence, claude --version + codex --version inside the VM).
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
- Real check: use the live workspace (see context) to run
  \`go run ./cmd/smithers workspace exec <id> --repo alice/smoke-test
  --command 'echo exec-works && node --version'\` against localhost:4000 and
  include the output in your summary.
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

function milestoneState(
  ctx: Parameters<Parameters<typeof smithers>[0]>[0],
  prefix: string,
) {
  const validate = ctx.outputMaybe("validate", { nodeId: `${prefix}:validate` });
  const gate = reviewGate(ctx, `${prefix}:review-moderator`);
  const validationPassed = validate !== undefined && validate.allPassed !== false;
  const done = validationPassed && gate.approved;
  const feedbackParts: string[] = [];
  if (validate && !validationPassed && validate.failingSummary) {
    feedbackParts.push(`VALIDATION FAILED:\n${validate.failingSummary}`);
  }
  if (gate.feedback) {
    feedbackParts.push(`REVIEW PANEL REJECTED:\n${gate.feedback}`);
  }
  return { done, feedback: feedbackParts.length > 0 ? feedbackParts.join("\n\n") : null };
}

export default smithers((ctx) => {
  const plueCliBin = ctx.input?.plueCliBin ?? "plue";
  const withBin = (prompt: string) =>
    `${prompt}\n\nPLUE CLI BINARY (built, logged in as alice against http://localhost:4000): ${plueCliBin}`;

  const m1 = milestoneState(ctx, "m1");
  const m2 = milestoneState(ctx, "m2");
  const m3 = milestoneState(ctx, "m3");
  const m4 = milestoneState(ctx, "m4");

  const summaryPrompt = `All four milestones of the plue-runner build have run
(see the spec at ${SPEC}). Milestone states: m1 done=${m1.done}, m2
done=${m2.done}, m3 done=${m3.done}, m4 done=${m4.done}. Inspect both repos'
working trees and recent commits (jj log in each) and produce: a summary of
what was built, the list of artifact paths (files created/changed, both
repos), and concrete followUps for anything not finished (including the
operator-only steps: gh repo creation, npm login + publish, e2e run of
run-on-plue with the demo child).`;

  return (
    <Workflow name="implement-plue-runner">
      <Sequence>
        <ValidationLoop
          idPrefix="m1"
          prompt={withBin(M1_PROMPT)}
          implementAgents={implementer}
          validateAgents={agents.cheapFast}
          reviewAgents={panelists}
          synthesizeReview
          feedback={m1.feedback}
          done={m1.done}
          maxIterations={3}
        />
        <ValidationLoop
          idPrefix="m2"
          prompt={withBin(M2_PROMPT)}
          implementAgents={implementer}
          validateAgents={agents.cheapFast}
          reviewAgents={panelists}
          synthesizeReview
          feedback={m2.feedback}
          done={m2.done}
          maxIterations={3}
        />
        <ValidationLoop
          idPrefix="m3"
          prompt={withBin(M3_PROMPT)}
          implementAgents={implementer}
          validateAgents={agents.cheapFast}
          reviewAgents={panelists}
          synthesizeReview
          feedback={m3.feedback}
          done={m3.done}
          maxIterations={3}
        />
        <ValidationLoop
          idPrefix="m4"
          prompt={withBin(M4_PROMPT)}
          implementAgents={implementer}
          validateAgents={agents.cheapFast}
          reviewAgents={panelists}
          synthesizeReview
          feedback={m4.feedback}
          done={m4.done}
          maxIterations={3}
        />
        <Task
          id="final-summary"
          output={summarySchema}
          agent={agents.smartTool}
          timeoutMs={900_000}
        >
          {summaryPrompt}
        </Task>
      </Sequence>
    </Workflow>
  );
});

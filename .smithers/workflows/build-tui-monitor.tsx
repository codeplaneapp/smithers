// smithers-source: authored
// smithers-display-name: Build TUI Monitor
// smithers-description: Build the OpenTUI + React single-run monitor TUI (replaces `up --interactive`) — write the spec, gate it, scaffold packages/tui, implement all five modes, wire the live gateway data layer + hijack, verify the gate green, and document.
// smithers-tags: tui, opentui, cli, monitor, scaffolding
/** @jsxImportSource smithers-orchestrator */
import { $ } from "bun";
import { createSmithers, Sequence, Branch, Loop, Approval, Task } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

/**
 * Build TUI Monitor — an end-to-end build pipeline that implements the
 * single-run Smithers monitor TUI in this repo, dogfooding Smithers to build a
 * Smithers feature.
 *
 * WHAT IT BUILDS
 * A full-screen terminal monitor for ONE workflow run, built with OpenTUI
 * (`@opentui/core`, native Zig core via Bun FFI) + its React 19 renderer
 * (`@opentui/react`). Because OpenTUI is a real React reconciler, the TUI REUSES
 * the exact gateway-react hooks the web `smithers ui` surface uses
 * (`useGatewayRun`, `useGatewayRunEvents`, `useGatewayNodeOutput`,
 * `useGatewayApprovals`, `useGatewayActions`) — same live WebSocket feed, NO
 * mocks. It SHIPS by replacing `smithers up --interactive`'s append-only stream
 * with this full-screen app.
 *
 * THE FIVE MODES (v1 = all of them), sharing one header + keybar:
 *   ① TREE     split-pane node tree ◂▸ node detail (Output/Logs/Diff/Props)
 *   ② GRAPH    DAG of nodes, `g` toggles
 *   ③ LOGS     live agent transcript, follow-mode + per-attempt filter
 *   ④ TIMELINE inspect-only event scrubber (j/k scrub, L live; no in-TUI rewind)
 *   ⑤ HIJACK   suspend the renderer → hand off to the agent's native CLI → resume
 *
 * WHY THIS SHAPE
 *  - ONE isolated <Worktree>: every build step runs on a single feature branch so
 *    the new package lands as one reviewable unit and the run is durable/
 *    resumable (a completed Task is never re-run on resume).
 *  - SEQUENTIAL mode builds (not Parallel): the modes share an app shell + a mode
 *    router, so concurrent agents in one working dir would race the shared files.
 *    A foundation step lays the shell + data layer; each mode then adds its own
 *    screen file and registers it.
 *  - A COMPUTE ORACLE is the authority on "done": agents cannot fake a compute
 *    task's exit code, so the verify Loop re-runs the REAL gate
 *    (`bun run typecheck` + `bun test` in the package) and only a green result
 *    flips `passed`.
 *  - PUSH-SAFE: every agent prompt bans pushing to origin; a human pushes the
 *    branch out-of-band after review.
 */

const PKG = "packages/tui";
const SPEC_PATH = "docs/specs/tui-monitor.md";

// The design contract the spec must capture and every builder must honor. Kept
// in one place so the design prompt and the build prompts agree.
const DESIGN_CONTRACT = `
SINGLE-RUN MONITOR TUI — DESIGN CONTRACT

Stack: Bun runtime; OpenTUI core (@opentui/core) + React 19 renderer
(@opentui/react). The TUI package uses the OpenTUI React JSX runtime
(jsxImportSource "@opentui/react") — needed so the OpenTUI intrinsic
elements (box/text/select/scrollbox/code/diff…) type-check — NOT plain
"react" and NOT smithers-orchestrator's jsx-runtime (that runtime is only
for workflow files). Render with
createCliRenderer({ exitOnCtrlC:false }) -> createRoot(renderer).render(...).

Data layer (NO mocks): wrap <SmithersGatewayProvider> (from
smithers-orchestrator/gateway-react) around the app and consume the SAME hooks
the web UI uses — useGatewayRun, useGatewayRunEvents, useGatewayNodeOutput,
useGatewayApprovals, useGatewayActions. The gateway client is headless-friendly:
inject the Bun global WebSocket and an in-memory sync backend; do NOT import
createGatewayReactRoot (react-dom) or the OPFS sqlite persistence (navigator.*).
Connect to the local Gateway (default http://127.0.0.1:7331), autostarting one
if absent, exactly like \`smithers ui\`.

Header (persistent every mode): status dot (cyan running / amber waiting /
red failed / green done / grey cancelled), workflow name, short run id, model,
ticking elapsed, live|paused indicator.

Five modes share the header + a bottom keybar:
  (1) TREE  — left: collapsible <scrollbox> node tree (indent + chevron ▾/▸/·,
      glyph ✓ ● ⏸ ○ ⊘ ✗, label + inline meta — NO per-node elapsed); right:
      NodeInspector with tabs
      Output/Logs/Diff/Props (NO Tools tab — the gateway exposes no per-node
      tool-call stream to the monitor), auto-defaulting per node kind (Output if
      it has output, Logs while running, Props for containers). Diff tab renders
      unified-diff text in a <code filetype="diff"> block (NOT an OpenTUI <diff>
      primitive); Output/Props use <code>. A waiting gate raises an approval
      banner with [a]approve [d]deny ([/] cycle a select's options).
  (2) GRAPH — DAG of nodes as <box> cards joined by ──▶, status-colored; \`g\`
      toggles between tree and graph.
  (3) LOGS  — live agent transcript in a <scrollbox>, follow-mode on by default
      (\`f\` toggles); \`[\`/\`]\` walk node attempts (NO tool side-effect badges —
      the gateway maps no tool-call events into the run-event stream).
  (4) TIMELINE — INSPECT-ONLY event scrubber (tick strip with notable + gate
      markers) showing node state reconstructed at the selected frame; \`j\`/\`k\`
      scrub, \`L\` back to live. NO in-TUI fork/rewind/replay/jump mutations: the
      live run-event stream carries no frame numbers, so a rewind would guess —
      rewind durably via the \`smithers rewind\` CLI instead.
  (5) HIJACK — on a running node, confirm via <select>, then renderer.suspend(),
      spawn the agent's native CLI handoff via \`smithers hijack <runId>\`
      (claude --resume / codex / etc., inheriting stdio). On a clean exit
      \`smithers hijack\` itself resumes the run, so the return banner only offers
      [d] dismiss (there is no fake "resume automation" action).

Keys: j/k+arrows move, space fold, ⏎ select, g graph, l logs, t timeline,
h hijack, a/d approve/deny, [/] cycle select options / walk attempts, ? help,
q quit. Esc closes overlays. (No global cancel/resume/copy key — drive those
from the CLI.) Responsive: useTerminalDimensions -> stack panes vertically
under a width threshold (compact mode).

Invocation (SHIPS): replace \`smithers up --interactive\` so it launches this
full-screen monitor after starting/attaching a run; \`smithers up --interactive\` with no
workflow still picks one, then monitors it.

Testing: terminal snapshot/interaction tests (e.g. @microsoft/tui-test or
OpenTUI's test renderer). CI has NO agent CLIs and NO browser — tests must seed
a fake agent / a seeded local Gateway and must not require a real model.
`;

// Where the build happens. We build DIRECTLY on main (a brand-new package has no
// conflict with existing files, matches the repo's "work on main" rule, and —
// critically — keeps the agents and the compute verify-oracle in the SAME
// directory; a <Worktree> put compute tasks in the launch root while agents ran
// in the worktree, so the oracle checked the wrong copy and agents got confused
// into copying files into main).
const MAIN_GUIDANCE = `
WORKING DIRECTORY — READ FIRST:
You are working DIRECTLY on the \`main\` branch at the smithers repo root
(${PKG} resolves from there). The package "${PKG}" ALREADY EXISTS with a working
foundation (Bun entry + provider stack, App shell + mode router, header, keymap
context, the gateway data adapter) AND the Tree mode fully built — it passes
\`pnpm -C ${PKG} typecheck\` and \`bun test\` (treeUtils unit tests). Build ON TOP
of the existing package, in place. Do NOT recreate it from scratch, do NOT
overwrite working files wholesale, do NOT create git/jj worktrees, and do NOT
copy files between directories or repos. Never run \`git push\`. Keep changes
scoped and additive.`;

const inputSchema = z.object({
  spec: z
    .string()
    .default(SPEC_PATH)
    .describe("Path the design spec is written to (defaults to docs/specs/tui-monitor.md)."),
  pkg: z.string().default(PKG).describe("Target package directory for the TUI."),
  review: z
    .boolean()
    .default(true)
    .describe("Pause for human approval of the spec before any code is written."),
});

// 1 — The written, buildable spec for the monitor.
const designSchema = z.looseObject({
  specPath: z.string().describe("Path the spec markdown was written to."),
  summary: z.string().describe("One sentence describing the monitor being built."),
  modes: z.array(z.string()).default([]).describe("The mode ids the spec commits to."),
  openQuestions: z.array(z.string()).default([]),
});

const approvalSchema = z.object({
  approved: z.boolean(),
  note: z.string().nullable().default(null),
});

// 2 — Package skeleton: deps, tsconfig (react jsx), entry + provider stack,
//     app shell, keymap, header, and the headless gateway data-layer adapter.
const scaffoldSchema = z.looseObject({
  summary: z.string(),
  filesWritten: z.array(z.string()).default([]),
  binCommand: z
    .string()
    .default("smithers-mon <runId>")
    .describe("How the monitor bin is invoked directly; the user entrypoint is `smithers up --interactive`."),
});

// 3 — One row per implemented mode (keyed by node id `mode-<id>`).
const modeSchema = z.looseObject({
  mode: z.string(),
  summary: z.string(),
  files: z.array(z.string()).default([]),
});

// 4 — Replacing `up --interactive` to launch the monitor.
const wiringSchema = z.looseObject({
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
});

// 5 — The verify Loop's authority: the REAL gate run as a compute task.
const verifySchema = z.object({
  passed: z.boolean(),
  command: z.string(),
  exitCode: z.number(),
  errors: z.array(z.string()).default([]),
});

// 6 — Agent-facing docs/skill so future agents know how to run the monitor.
const documentSchema = z.looseObject({
  summary: z.string(),
  docsTouched: z.boolean().default(false),
});

// 7 — Terminal summary surfaced as the run's printed output.
const outputSchema = z.object({
  status: z.string().describe("built | verify-failed | denied | designed | incomplete."),
  summary: z.string(),
  specPath: z.string(),
  pkg: z.string(),
  modesBuilt: z.array(z.string()).default([]),
  verified: z.boolean().default(false),
});

// The five modes, built sequentially after the foundation is scaffolded. Each
// owns its own screen file plus a one-line registration in the mode router.
const MODES = [
  {
    id: "tree",
    title: "① Tree + Node detail",
    detail:
      "Split-pane: left collapsible node <scrollbox> tree; right NodeInspector with Output/Logs/Diff/Props tabs (NO Tools tab — no per-node tool-call stream exists; Diff renders unified-diff text via <code filetype=\"diff\">, Output/Props via <code>), auto-default tab per node kind, and the approval banner when a gate is waiting. This is the home mode.",
  },
  {
    id: "graph",
    title: "② Graph DAG",
    detail:
      "Status-colored node cards joined by ──▶ arrows, laid out left-to-right; `g` toggles tree<->graph; ⏎ inspects the selected node (shares selection with tree mode).",
  },
  {
    id: "logs",
    title: "③ Logs / live transcript",
    detail:
      "Live agent transcript in a <scrollbox> from useGatewayRunEvents, follow-mode on by default (`f`), `[`/`]` to walk node attempts. NO tool side-effect badges — the gateway maps no tool-call events into the run-event stream, so a read/write/shell badge would never fire.",
  },
  {
    id: "timeline",
    title: "④ Timeline / frames",
    detail:
      "INSPECT-ONLY event scrubber (tick strip with notable + gate markers) showing node state reconstructed at the selected frame; `j`/`k` scrub, `L` back to live. NO in-TUI jump/fork/rewind/replay mutations — the live run-event stream carries no frame numbers; rewind durably with the `smithers rewind` CLI instead.",
  },
  {
    id: "hijack",
    title: "⑤ Hijack handoff",
    detail:
      "On a running node, confirm via <select>, renderer.suspend(), spawn `smithers hijack <runId>` inheriting stdio. On a clean exit `smithers hijack` resumes the run itself, so the return banner only offers [d] dismiss (no fake 'resume automation' action).",
  },
] as const;

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  design: designSchema,
  approval: approvalSchema,
  scaffold: scaffoldSchema,
  mode: modeSchema,
  wiring: wiringSchema,
  verify: verifySchema,
  document: documentSchema,
  output: outputSchema,
});

export default smithers((ctx) => {
  const review = ctx.input.review ?? true;
  const pkg = ctx.input.pkg ?? PKG;
  const specPath = ctx.input.spec ?? SPEC_PATH;

  const design = ctx.outputMaybe(outputs.design, { nodeId: "design" });
  const approval = ctx.outputMaybe(outputs.approval, { nodeId: "approve-spec" });
  const scaffold = ctx.outputMaybe(outputs.scaffold, { nodeId: "scaffold" });
  const wiring = ctx.outputMaybe(outputs.wiring, { nodeId: "wire-cli" });
  const documentation = ctx.outputMaybe(outputs.document, { nodeId: "document" });

  const designed = design !== undefined;
  const approved = !review || approval?.approved === true;
  const denied = review && approval?.approved === false;
  const proceed = designed && approved;

  // Which modes have landed, read back from their persisted rows.
  const builtModes = MODES.filter((m) => ctx.outputMaybe(outputs.mode, { nodeId: `mode-${m.id}` }) !== undefined);
  const allModesBuilt = builtModes.length === MODES.length;

  // Verify Loop authority: the highest-iteration real-gate result.
  const lastVerify = (ctx.outputs.verify ?? []).at(-1);
  const verifyPassed = lastVerify?.passed === true;

  const status = denied
    ? "denied"
    : documentation && verifyPassed
      ? "built"
      : allModesBuilt && lastVerify && !verifyPassed
        ? "verify-failed"
        : designed
          ? scaffold
            ? "incomplete"
            : "designed"
          : "incomplete";

  const summary =
    documentation?.summary ??
    (allModesBuilt ? `Built the ${PKG} monitor (${builtModes.length}/${MODES.length} modes).` : design?.summary) ??
    "Building the single-run monitor TUI.";

  return (
    <Workflow name="build-tui-monitor">
      <Sequence>
        {/* 1 — Write the buildable spec from the design contract. */}
        <Task id="design" output={outputs.design} agent={agents.smart}>
          {`You are designing the single-run Smithers monitor TUI. Write a concise,
buildable engineering spec to "${specPath}" (create the directory if needed).

Anchor the spec to THIS exact design contract — do not invent a different UI:
${DESIGN_CONTRACT}

The spec must include, in order:
1. Goal + how it ships (replaces \`smithers up --interactive\`).
2. Runtime & stack (Bun, OpenTUI core + @opentui/react, React 19; the package
   uses standard react JSX, not the smithers jsx-runtime).
3. The data layer: reusing gateway-react hooks via <SmithersGatewayProvider>
   with an injected Bun WebSocket + in-memory sync backend; connecting to the
   local Gateway (autostart like \`smithers ui\`). List every hook used and what
   it feeds.
4. The bootstrap/provider stack (createCliRenderer -> createRoot -> providers ->
   App), modeled on a proven OpenTUI entry point.
5. Each of the five modes: layout, the OpenTUI elements used (box/text/scrollbox/
   select/code/diff), data source, and keybindings.
6. The full keymap + responsive/compact behavior.
7. Testing strategy that works in CI (no agent CLIs, no browser): a seeded local
   Gateway / fake agent, terminal snapshot + interaction tests.
8. A file/module layout for ${pkg} and the CLI wiring change.

Read the existing surfaces for grounding before writing: apps/cli/src/tui.js
(today's --interactive stream), packages/gateway-react/src (the hooks),
packages/protocol (the DevTools frame protocol), and apps/cli/src/hijack.js.

Do NOT write any code yet and do NOT push. Report the spec path, a one-line
summary, the mode ids, and any open questions.`}
        </Task>

        {/* 2 — Optional durable human approval of the spec before any code. */}
        <Branch
          if={review && designed}
          then={
            <Approval
              id="approve-spec"
              output={outputs.approval}
              request={{
                title: "Build the single-run monitor TUI from this spec?",
                summary: design?.summary ?? `Spec written to ${specPath}.`,
              }}
              onDeny="continue"
            />
          }
        />

        {/* 3 — Build everything directly on main (new package, no conflicts;
            keeps agents + compute verify-oracle in the same directory). */}
        {proceed ? (
            <Sequence>
              {/* 3a — Foundation: deps, tsconfig, entry + provider stack, app
                  shell, mode router, keymap context, header, and the headless
                  gateway data-layer adapter. No mode screens yet. */}
              <Task id="scaffold" output={outputs.scaffold} agent={agents.smartTool} heartbeatTimeoutMs={900_000}>
                {`${MAIN_GUIDANCE}

VERIFY the ${pkg} foundation against the spec at "${specPath}" and fill any gaps.
The package is already scaffolded and passing typecheck — do NOT rewrite working
files. Confirm these foundation pieces exist and match the spec; add only what is
missing:

- package.json: name "@smithers-orchestrator/tui" (publishable, NOT private —
  it ships the runnable "smithers-mon" bin), bin "smithers-mon" -> "./src/index.tsx"
  (run directly under Bun). Runtime deps: "@opentui/core", "@opentui/react",
  "@smithers-orchestrator/gateway-client" (workspace:*),
  "@smithers-orchestrator/gateway-react" (workspace:*), and "react" + "react-dom"
  (real dependencies — the bin loads react-dom/client via gateway-react, so a
  standalone install must resolve them; do NOT make them peers or add "zod" /
  "smithers-orchestrator"). Match this repo's workspace + build conventions (look
  at a sibling package's package.json/tsconfig). Wire its "test"/"typecheck"
  scripts like siblings.
- tsconfig.json: STANDARD react JSX (jsx "react-jsx", jsxImportSource
  "@opentui/react"). NOT smithers-orchestrator. This is an OpenTUI React app,
  not a workflow.
- src/index.tsx entry (#!/usr/bin/env bun): assert TTY, parse a runId arg,
  createCliRenderer({ exitOnCtrlC:false }), createRoot(renderer), and mount the
  provider stack: ErrorBoundary > RendererProvider > Keybindings >
  SmithersGatewayProvider (inject the Bun global WebSocket; connect to the local
  Gateway, autostarting one if none is reachable, like \`smithers ui\`; use an
  in-memory sync backend — do NOT import createGatewayReactRoot or the OPFS
  persistence) > SyncProvider > the App shell. (There is NO Theme provider.)
- The App shell: persistent header (useGatewayRun), a mode router that swaps the
  body between the five modes, a bottom keybar, a global useKeyboard handler
  bound to a keymap context, and useTerminalDimensions-driven compact mode.
- A small data adapter module exposing typed selectors over the gateway hooks
  (run, nodes/tree, node output, approvals, events) so mode screens stay thin.

Verify it boots and typechecks (bun run typecheck in ${pkg}); a placeholder body
per mode is fine for now. Do NOT push. Report files written and the bin command.`}
              </Task>

              {/* 3b — Each mode, sequentially, on the same branch. */}
              {scaffold
                ? MODES.map((m) => {
                    const already = ctx.outputMaybe(outputs.mode, { nodeId: `mode-${m.id}` });
                    return already ? null : (
                      <Task
                        key={m.id}
                        id={`mode-${m.id}`}
                        output={outputs.mode}
                        agent={agents.smartTool}
                        heartbeatTimeoutMs={900_000}
                      >
                        {`${MAIN_GUIDANCE}

Implement the "${m.title}" mode of the monitor TUI in ${pkg},
following the spec at "${specPath}" and this design contract:
${DESIGN_CONTRACT}

This mode specifically:
${m.detail}

If this mode is ALREADY implemented and passing, just verify it against the spec
and report — change only what is needed. (The Tree mode is already complete.)

Rules:
- Build it as its own screen file/module and register it in the mode router the
  scaffold created. Reuse the existing app shell, header, keymap context, and
  the gateway data adapter — do not fork them.
- Use OpenTUI elements (box/text/scrollbox/select/code/diff) and hooks
  (useKeyboard/useTerminalDimensions) only; pull live data from the gateway
  hooks (no mocks, no fabricated data).
- Keep \`bun run typecheck\` green in ${pkg}. Add at least one terminal test for
  this mode that runs in CI without an agent CLI or browser (seed a local
  Gateway / fake agent; snapshot or assert key interactions).
- Stay scoped to this mode + its registration line. Do NOT push.

Report { mode: "${m.id}", summary, files }.`}
                      </Task>
                    );
                  })
                : null}

              {/* 3c — Ship it: replace `up --interactive` with the monitor. */}
              {allModesBuilt ? (
                <Task id="wire-cli" output={outputs.wiring} agent={agents.smartTool} heartbeatTimeoutMs={600_000}>
                  {`${MAIN_GUIDANCE}

Wire the monitor into the CLI so it SHIPS. In apps/cli, make
\`smithers up --interactive\` launch the new ${pkg} full-screen monitor instead of
today's append-only stream (apps/cli/src/tui.js): after a run is started or
attached, hand off to the monitor for that runId. \`smithers up --interactive\` with no
workflow must still pick a workflow interactively, then monitor the run it
starts. Preserve detached/non-interactive behavior unchanged. Keep the existing
append-only streaming code path available as a fallback for when the
@smithers-orchestrator/tui package isn't installed (e.g. a slim install);
interactive mode itself requires a TTY.

Update --help text accordingly. Keep typecheck green. Do NOT push.
Report a summary and the files changed.`}
                </Task>
              ) : null}

              {/* 3d — Verify Loop: the REAL gate is the authority. Each pass runs
                  the gate (compute, unfakeable); if it fails, an agent fixes,
                  and the Loop re-checks until green or the cap is hit. */}
              {allModesBuilt && wiring ? (
                <Loop id="verify" until={verifyPassed} maxIterations={6} onMaxReached="return-last">
                  <Sequence>
                    <Task id="verify-check" output={outputs.verify}>
                      {async () => {
                        const cmd = `bun run typecheck && bun test`;
                        const res = await $`cd ${pkg} && bun run typecheck && bun test`.nothrow().quiet();
                        const out = `${res.stdout?.toString() ?? ""}\n${res.stderr?.toString() ?? ""}`;
                        const errors = out
                          .split("\n")
                          .filter((l) => /error|fail|✗|✖/i.test(l))
                          .slice(0, 40);
                        return { passed: res.exitCode === 0, command: cmd, exitCode: res.exitCode, errors };
                      }}
                    </Task>
                    {(ctx.latest("verify", "verify-check") as { passed?: boolean } | undefined)?.passed === false ? (
                      <Task id="verify-fix" output={outputs.mode} agent={agents.smartTool} heartbeatTimeoutMs={900_000}>
                        {`${MAIN_GUIDANCE}

The ${pkg} gate (\`bun run typecheck && bun test\`) is RED.
Failing output (truncated):

${((ctx.latest("verify", "verify-check") as { errors?: string[] } | undefined)?.errors ?? []).join("\n")}

Fix the root cause in ${pkg} until both typecheck and the package tests pass. Do
not weaken or delete tests to go green, and do not stub real gateway data. Stay
in ${pkg} (plus the apps/cli wiring if that's the failure). Do NOT push.
Report { mode: "verify-fix", summary, files }.`}
                      </Task>
                    ) : null}
                  </Sequence>
                </Loop>
              ) : null}

              {/* 3e — Document for the next agent once the gate is green. */}
              {verifyPassed ? (
                <Task id="document" output={outputs.document} agent={agents.smart} heartbeatTimeoutMs={600_000}>
                  {`The monitor TUI is built and the gate is green. Document it for
the next agent/user: a short README in ${pkg}, and update the relevant CLI docs
to describe that \`smithers up --interactive\` now opens the full-screen monitor
and its keybindings/modes. If you edit anything under docs/, regenerate the LLM
bundles (\`pnpm docs:llms\`) so check-docs/check-llms stay green. Do NOT push.
Report a summary and whether docs/ was touched.`}
                </Task>
              ) : null}
            </Sequence>
        ) : null}

        {/* Terminal summary surfaced as the run's printed output. */}
        <Task id="summarize" output={outputs.output}>
          {{
            status,
            summary,
            specPath,
            pkg,
            modesBuilt: builtModes.map((m) => m.id),
            verified: verifyPassed,
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});

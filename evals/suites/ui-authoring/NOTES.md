# ui-authoring — notes

Authoring UI evals: can a (usually weak) candidate model one-shot a custom
workflow UI bundle (single `.tsx`)? Each case's `verify.kind` is `build`, so the
`buildVerify` gate (`evals/lib/verify.ts`) transpiles the candidate artifact and
requires the `verify.must` API tokens to appear in the source. The `ui-quality`
judge (`qualityPrompt` in `evals/lib/eval-kit.tsx`, attached automatically for
build cases) then grades design, UX, correct hook use, and — as of the
gateway-ui event-log work — whether the UI includes the monitor-open affordance
(`MonitorButton`).

## Cases

One `taskId` per capability, fanned across a few candidate models:

- `ui-run-status-events`, `ui-approvals`, `ui-runs-list`, `ui-node-output`,
  `ui-status-header`, `ui-loop-node-output-row` — the core gateway-react hooks.
- `ui-dashboard-full` — the polished multi-pane dashboard (sota tier).
- `ui-monitor-button` (sonnet, haiku) — must compose the shipped
  `MonitorButton` from `smthrs/gateway-ui` and deep-link the run
  into the Monitor rather than hand-rolling the link. `must` tokens:
  `smthrs/gateway-ui` + `MonitorButton` (plus the usual
  `createGatewayReactRoot` mount). This is the fluency signal that agents reach
  for the shipped monitor affordance instead of reinventing a `/monitor` anchor.

## Running

`bunx smthrs eval evals/suites/ui-authoring` (or `smithers up`
the suite's `eval.tsx`). Candidate models resolve through `evals/agents.ts`; on a
stock checkout the claude-backed ones (`haiku`, `sonnet`) run out of the box,
while `gemini`/`kimi` need their respective CLIs/accounts (see
`../ui-functional/NOTES.md` for the same environment caveats).

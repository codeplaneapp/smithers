# ui-functional — notes

Functional UI evals: the candidate authors a custom workflow UI (`.tsx`) and the
`ui-functional` verifier (`evals/lib/ui-functional-runner.ts`) BOOTS it in a real
headless Chromium against the deterministic `ui-eval-fixture` run, asserting 7
observed behaviors: `mounts`, `status`, `events` (from every task), `output`,
`error` (the failed node is surfaced), `approval`, `approvalLive` (clicking
Approve resumes the run to `finished`). The ui-quality judge then grades polish
against what actually rendered.

## Requirements to run

- **Chromium** (the `playwright` devDependency of `apps/cli`). Without it the
  runner emits a `SKIP` verdict.
- The candidate model must be runnable locally. On a stock checkout only the
  **claude-backed** models resolve out of the box:
  - `haiku`, `sonnet` — via the `claude` CLI. ✅ both one-shot the full dashboard.
  - `gemini` — needs the `gemini` CLI to actually serve `gemini-3.5-flash`; it
    fails **preflight** locally if that model isn't available to the CLI. This is
    an environment block, not a docs gap.
  - `kimi` — needs a configured Kimi account at `~/.smithers/accounts/kimi-1`;
    without it the agent fails with `LLM not set` (non-retryable config error).

A case that fails for one of these infra reasons shows `status: failed` with an
empty candidate output — distinct from a real functional failure, which produces
a `verdict` with the failing checks named.

## Baseline (2026-07-06, post doc-fix)

- haiku: **7/7 functional PASS**
- sonnet: **7/7 functional PASS**
- gemini / kimi: infra-blocked locally (see above)

The first doc-improvement round (driven by candidate friction reports) fixed the
client event-frame shape in `docs/reference/event-types.mdx`, the `submitApproval`
`decision` shape + approvals-array + node-output row shapes in
`docs/reference/gateway-react.mdx` and `docs/guides/custom-workflow-ui.mdx`, and
added the UI guide to the llms manifest so those reach the bundle a candidate reads.

# Tickets

Existing flat tickets (`0009-0014`) are Smithers-repo DevTools/CLI work.
Tickets from the 2026-04-16 hardening memo are organized by target repo:

## `smithers/` — this repo (`codeplaneapp/smithers`)

Phase 0 — operator trust, recovery, CLI:

- [0015](smithers/0015-authoritative-run-state-model.md) — Authoritative run-state model (no more `idle`)
- [0016](smithers/0016-dual-heartbeats.md) — Engine + UI heartbeats
- [0017](smithers/0017-run-lease-owner-epoch.md) — Run lease + owner epoch (single owner, fenced writes)
- [0018](smithers/0018-recovery-state-machine.md) — Typed recovery transitions + supervisor policy
- [0019](smithers/0019-side-effect-idempotency-metadata.md) — Tool side-effect / idempotency metadata
- [0020](smithers/0020-cli-why-doctor-repair.md) — `smithers why` / `doctor run` / `repair` + prefix IDs + `--json`
- [0021](smithers/0021-docs-as-contracts.md) — Docs maturity labels + CI smoke tests
- [0022](smithers/0022-fault-injection-e2e-matrix.md) — E2E fault-injection matrix
- [0023](smithers/0023-gateway-reference-deployment.md) — Gateway stable RPC + reference deployment

Phase 0.5 — 2026-04-25 hardening review (CI honesty + import contracts):

- [0024](smithers/0024-cli-json-stdout-contamination.md) — CLI `--json` stdout contamination + duplicate Effect runtime
- [0025](smithers/0025-pi-tui-undeclared-dependency.md) — `@mariozechner/pi-tui` is an undeclared dep of `smithers`
- [0026](smithers/0026-smithers-workspace-typecheck-and-agentlike.md) — `.smithers` workspace fails `tsc`; `AgentLike` contract diverges
- [0027](smithers/0027-root-validation-scope-gaps.md) — Root `typecheck`/`lint` scope too narrow — false-green CI

This-repo features:

- [0029](smithers/0029-global-settings-and-global-workflows.md) — Global settings + global workflows (OS-convention config home, à la Claude Code / Codex)

Onboarding feedback (2026-06-17, from X/Twitter replies asking for feedback):

- [0039](smithers/0039-getstarted-routes-to-for-agents.md) — "Get started" CTA links into the "For Agents" tab instead of human onboarding
- [0040](smithers/0040-no-manual-skill-install.md) — Onboarding must not require hand-installing skills (mkdir + curl); `skills` does it
- [0041](smithers/0041-skills-step-wording-implies-manual-work.md) — Skills messaging reads as an extra manual step; keep it out of "Get started"
- [0042](smithers/0042-cut-onboarding-volume.md) — Cut get-started ~75–80%: 1–3 steps, stop bombarding with choices
- [0043](smithers/0043-one-command-helloworld-mdx-default.md) — Default first-run = 1 command + editable hello-world `.mdx` template
- [0044](smithers/0044-default-to-mdx-deprioritize-sdk.md) — Default onboarding to MDX; keep TS SDK but not front-and-center

> Removed 2026-06-18 (stale / other-repo, per CLAUDE.md): the jjhub-parity set
> (0030–0038) and `0028` (vector memories) targeted the deprioritized
> `apps/smithers` / Studio-2 POCs; `real-stack-e2e/*` targeted the separate
> `../plue` product repo; `0045` (record a walkthrough stream) is a human task;
> `0001`/`0002` were kanban demo fixtures; `0003` (6LARP, complete) → `.done/`.

Bulletproof-audit follow-ups (triaged 2026-06-18 against `main`, post-#442 merge train).
These hold the **still-open** findings from the 2026-06-16 audit GitHub epics after the
#312–#442 fix/test/refactor wave; each ticket links its source issue and lists only the
remaining work. Of 443 tracked findings/items, ~155 have landed; the rest live here:

> **Kanban staging (2026-06-20):** the multi-item epics (0022, 0046, 0047, 0052, 0056)
> were moved to `.epics/` (a dot-dir the kanban workflow skips) so kanban processes one
> ticket per fix instead of a multi-week epic. The #306 test-coverage epic (0052) was
> decomposed into per-finding `smithers/cov-*.md` tickets — each is its own kanban
> worktree and its own commit on `main`. The `.epics/` files remain the source-of-record
> that map to their GitHub issues.

**Still open (GitHub issue open):**

- [0046](.epics/0046-audit-p0-blockers.md) — P0 critical blockers ([#299](https://github.com/smithersai/smithers/issues/299), **open** — real-product rewrite of the remaining ~17 fabricated-schema fault cases; multi-week e2e infra)
- [0047](.epics/0047-audit-ci-architecture-systemic.md) — CI enforcement, architecture & systemic policy ([#300](https://github.com/smithersai/smithers/issues/300), **5 of 34 landed since triage, 29 open** — lint/typecheck-examples/examples-bun-test/e2e-boundary-scan/tsconfig-paths gates landed; CLI monolith, checkJs off, exports/boundary drift, agents↔observability publish cycle remain)
- [0052](.epics/0052-audit-test-coverage-gaps.md) — Test coverage gaps ([#306](https://github.com/smithersai/smithers/issues/306), **open — ~51 of 90 resolved, ~39 open** (re-verified 2026-06-22) — OTLP entry layers, review CLI/action drivers, fabricated/skip-only e2e fault cases, gateway-react sync branches remain)
- [0054](smithers/0054-degraded-partial-failure-run-status.md) — Degraded/partial-failure run status ([#295](https://github.com/smithersai/smithers/issues/295), open — masked failed children; not started)
- [0056](.epics/0056-integrations-tool-catalog.md) — Integrations tool catalog ([#222](https://github.com/smithersai/smithers/issues/222), 72 of 87 open — OAuth plane is the load-bearing gap; Tier 1 connector backlog)
- _#446 Gateway origin allow-list (`allowedOrigins`) only exists for trusted-proxy mode, not token/jwt — open ([#446](https://github.com/smithersai/smithers/issues/446)); no dedicated ticket yet._

**Closed & archived in `.done/` (source GitHub issue resolved):**

- [0048](.done/0048-audit-dead-code-cleanup.md) — Dead code cleanup ([#301](https://github.com/smithersai/smithers/issues/301) ✅ closed 2026-06-20 — 66 findings dispositioned; half-migrated DB-schema dedup tracked separately as a refactor)
- [0049](.done/0049-audit-stubbed-missing-features.md) — Stubbed & missing features ([#302](https://github.com/smithersai/smithers/issues/302) ✅ closed)
- [0050](.done/0050-audit-bug-fixes.md) — Bug fixes ([#303](https://github.com/smithersai/smithers/issues/303) ✅ closed)
- [0051](.done/0051-audit-docs-skills-accuracy.md) — Documentation & skills accuracy ([#304](https://github.com/smithersai/smithers/issues/304) ✅ closed — 10/11; remaining item is an external installed-skill fix, out of scope here)
- [0053](.done/0053-audit-code-cleanup-refactors.md) — Code cleanup & refactors ([#307](https://github.com/smithersai/smithers/issues/307) ✅ closed — 24/25 done; approval-continue usage capture deferred with rationale)
- [0055](.done/0055-quota-aware-pause-and-resume.md) — Quota-aware pause & resume ([#324](https://github.com/smithersai/smithers/issues/324) ✅ closed 2026-06-21 — usage-limit/quota errors now pause into `waiting-quota` without burning retries and resume after the reset; verified in source 2026-06-22)

## `jjhub/` — `/Users/williamcory/jjhub`

Make JJHub the blessed Smithers runtime:

- [0001](jjhub/0001-runtime-capability-contract.md) — Runtime capability contract
- [0002](jjhub/0002-implement-runtime-on-workspaces.md) — Implement runtime on JJHub workspaces
- [0003](jjhub/0003-web-ui-inspector-backend.md) — Web UI Smithers inspector surface
- [0004](jjhub/0004-smithers-on-jjhub-reference.md) — Reference architecture + example

## `gui/` — `/Users/williamcory/gui` (Swift macOS app)

- [0001](gui/0001-consume-devtools-snapshot.md) — Consume DevToolsSnapshot / delta stream
- [0002](gui/0002-reconnect-cursor-ghost-state.md) — Reconnect-from-cursor + ghost state

## Dependency order (abridged)

```
smithers/0015 ─┬─ 0016 ─┐
               ├─ 0017 ─┼─ 0018 ─┬─ 0020 ─ 0022
               │        │        └─ 0023 ─ jjhub/0003 ─ gui/0001 ─ gui/0002
               └─ 0019 ─┘                              ↘
                                              jjhub/0001 ─ jjhub/0002 ─ jjhub/0004
```

Phase 0 (weeks 1–4): smithers/0015–0021.
Phase 1 (weeks 5–12): smithers/0022–0023, jjhub/0001–0002, gui/0001.
Phase 2 (weeks 13+): jjhub/0003–0004, gui/0002.

## Out of scope (for now)

- **`codeplane`**: surveyed (`/Users/williamcory/codeplane`) — parallel
  project with its own `cli/server/tui/codeplanectl` apps. Not treated
  as a Smithers runtime consumer in this round; revisit if codeplane
  adopts the Gateway contract.
- Core engine (DAG, reconciler, JSX, SQLite) — explicitly preserved per
  memo "What I would not change."

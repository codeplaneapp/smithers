# Documentation & skills accuracy — remaining

> Target repo: **smithers** (this repo)
> Source: GitHub issue [#304](https://github.com/smithersai/smithers/issues/304) · 2026-06-16 bulletproof audit
> Triaged 2026-06-18 against `main` (post-#442 merge train): **36 of 47 resolved, 11 still open**

## Context

Doc/skill accuracy defects. 36 of 47 fixed; these 11 are leftover JSDoc/comment/changelog edits no PR touched (plus one external-skill item out of this repo's scope).

Each item below is still open in current `main`. Text is the original audit finding (severity + file:line). `remaining:` notes come from the 2026-06-18 verification pass. Check items off here as they land, and mirror the check-off on issue #304.

## Open items

- [x] **P2** 0.22.0 changelog claims 'Ten canonical starters' but only nine are defined — `docs/changelogs/0.22.0.mdx:128`
  - _remaining:_ Changelog still says 'Ten' and lists idea-to-prd; only 9 starters exist and it was renamed to idea-to-tickets. Not corrected.
- [x] **P2** flake-log.md is empty, so the documented promotion gate (0 flakes / 100 CI runs) cannot have been applied — yet fabricated cases were 'promoted' to per-PR — `e2e/flake-log.md:9-11; e2e/README.md:42-46; .github/workflows/faults.yml:35`
  - _remaining:_ Documented 0-flakes/100-runs promotion gate (flake-log.md, e2e/README.md:42-46) is described but not implemented; flake-log empty.
- [ ] **P2** Doc inconsistency: shared/models.md lists Sonnet 4 retirement as 'TBD' while model-migration.md says 'June 15, 2026' (note: claude-api is an installed skill, not the smithers repo) — `(external skill) claude-api/shared/models.md`
  - _remaining:_ External claude-api skill, out of scope for this repo; cannot be verified or fixed from this checkout. Issue text itself flags it as '(external skill)'.
- [x] **P2** 0.17.0 changelog documents the accounts public API incorrectly (async + wrong provider id + wrong getAccount signature) — `docs/changelogs/0.17.0.mdx:327-336`
  - _remaining:_ Changelog accounts API example still async + wrong provider id + wrong getAccount signature.
- [x] **P2** SuperSmithers JSDoc contradicts its own apply implementation about what writes files — `packages/components/src/components/SuperSmithers.js:18 vs 77-80`
  - _remaining:_ JSDoc still attributes file writes to the compute step; the agent (Task 2) actually edits files.
- [x] **P2** Stale 'Phase 0 Seam Adapter' doc comment claims the bridge will be replaced by Activity.make() — `packages/engine/src/effect/workflow-bridge.js:29-38`
  - _remaining:_ Stale Phase 0/Phase 1 future-tense comment not updated.
- [x] **P2** TaskAspects missing from index.js @smithers-type-exports block (export-marker inconsistency) — `packages/graph/src/index.js:2-30`
  - _remaining:_ TaskAspects still missing from the hand-maintained export-marker block (the generated .d.ts does export it, so consumer impact is nil).
- [x] **P2** inspect()/decide() JSDoc signatures omit the options/depth parameters — ``
  - _remaining:_ inspect()/decide() JSDoc still omit the options/depth params.
- [x] **P2** ConnectionState typedef field `subscribe?: Set<string>` is stale (runtime uses `subscribedRuns`) — `packages/server/src/gateway.js:81`
  - _remaining:_ Typedef field name (subscribe) still doesn't match the impl (subscribedRuns).
- [x] **P2** Doc claims a 'generation counter' stale-fence for useGatewayExtensionStream that does not exist in code — `packages/gateway-react/src/useGatewayExtensionStream.ts:28-31 (JSDoc) vs 55-104 (impl); docs/guides/custom-workflow-ui.mdx:110,221-227`
  - _remaining:_ Hook's JSDoc still claims a generation-counter stale-fence that doesn't exist in this hook (it aborts via AbortController).
- [x] **P2** workflow-ui-all.e2e.test.js docstring says 'ALL 15 UIs' but the harness covers 16 descriptors — `apps/cli/tests/workflow-ui-all.e2e.test.js:24`
  - _remaining:_ Docstring count (15) still does not match the harness's 16 descriptors.

## Resolution (2026-06-19)

All 10 in-repo items fixed: 0.22.0 changelog (Nine/idea-to-tickets), 0.17.0
accounts API example (sync + `claude-code` + `getAccount(label)`), SuperSmithers
JSDoc, workflow-bridge Phase-0 comment, graph `TaskAspects` export marker,
`inspect()`/`decide()` JSDoc params, gateway `ConnectionState.subscribedRuns`
typedef, `useGatewayExtensionStream` AbortController JSDoc (+ its generated
`index.d.ts` mirror), `workflow-ui-all` 16-UI docstring, and the e2e flake-log
promotion-gate honesty note. check-docs / check-llms / lint green; 6 touched
packages typecheck.

The one remaining item (`claude-api/shared/models.md` Sonnet-retirement date) is
in an **external installed skill, not this repo** — not actionable from this
checkout. Closing here.

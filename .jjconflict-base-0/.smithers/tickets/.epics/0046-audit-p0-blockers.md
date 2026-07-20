# P0 critical blockers — remaining

> Target repo: **smithers** (this repo)
> Source: GitHub issue [#299](https://github.com/smithersai/smithers/issues/299) · 2026-06-16 bulletproof audit
> Triaged 2026-06-18 against `main` (post-#442 merge train): **3 of 4 resolved, 1 still open**

## Context

The remaining P0 audit blocker(s) from the 2026-06-16 bulletproof audit. The other three P0s (smithers test script, real-Gateway fault cases, jj snapshot coverage) landed via #414/#415/#413.

Each item below is still open in current `main`. Text is the original audit finding (severity + file:line). `remaining:` notes come from the 2026-06-18 verification pass. Check items off here as they land, and mirror the check-off on issue #299.

## Open items

- [ ] **P0** 22 of 30 fault cases fabricate their own SQL schema and reimplement the feature in-test — they validate a mock of the contract, not the product — `e2e/faults/case12-rewind-reverts-vcs.test.ts:160-221; e2e/faults/case14-gateway-rpc-roundtrip.test.ts:196-485; e2e/faults/case03,case17,case24,case26,case27`
  - _remaining:_ Largest item. ~17 of the 22 fabricated-schema cases (incl. cited case24, case27, plus case04/05/07/10/11/13/18 etc.) still fabricate schema and reimplement product logic in-test. Maintainer comment confirms this is the open remainder.
  - _scope assessment (2026-06-19):_ Genuinely multi-week e2e test-infrastructure work, **not a single fix** — the dominant unresolved audit item. Each of the ~17 cases must be rewritten to drop its hand-rolled SQL schema + in-test feature reimplementation and instead seed a **real** gateway/DB fixture (per the repo "No mocks" rule) and inject the fault against the real product path. Per case that means: stand up the real Gateway server + workspace DB the case targets, seed deterministic real data, drive the actual RPC/rewind/reconnect code path, and assert on real product behavior under fault injection — each case is effectively its own small project. It cannot be honestly closed in one session without re-mocking, which would re-introduce the exact defect flagged. Recommended: convert one at a time (start with case14 gateway-rpc-roundtrip and case12 rewind), each as its own verified PR, until the fabricated-schema count reaches zero.

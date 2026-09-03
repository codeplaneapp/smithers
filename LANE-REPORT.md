# Land lane report

## Result

- Landed the merged executor, declaration conversion, integration, migration-docs, and compatibility-sweep work on one build system.
- Removed the remaining compatibility fields from `GithubTarget.PrInvocation` and `Outward.Invocation`, including their executor call sites and tests.
- Replaced the old cargo dual-form constructors and `CargoLint`/`CargoTest` targets with the single `Cargo.Fmt`, `Cargo.Clippy`, and `Cargo.Test` declarations. Converted `crates/flows-jj/PACKAGE.ts` to those targets and removed the obsolete tests and exports.
- Renamed the naked-target diagnostic to `naked_target_export`, removed stale declaration-loader terminology, and retained the intentional hard error when discovery encounters a consumer's historical declaration file.
- Fixed a merge omission in `packages/ui-styleguide/PACKAGE.ts`: its two targets are now private declarations in the exported `Package` map.
- Removed every non-fixture hit from the required banned-word scan, including the obsolete public cache-result spelling, now `CacheOutcome`.
- Regenerated the CI workflow, package/API documentation, all LLM bundles, and `known-files.d.ts` (last, after deleting the obsolete cargo test file).

The final banned-word scan reports only the two lines in `PackageDiscovery.ts` that detect a consumer's historical declaration file and raise the required hard error.

## Decisions

- `Api.Compat` remains. As the compatibility-sweep report decided, this is the current API-surface/version gate, not an alternate accepted API.
- The build CLI's single-instance Effect resolver remains, but its declaration classification no longer admits the removed declaration format.
- No dependency or coverage threshold changed.

## Gates

`pnpm run check` — pass:

```text
examples check: Done
packages/build-cli check: Done
apps/ui check: Done
exit 0
```

`pnpm run lint` — pass after formatting the platform-browser table:

```text
packages/evals lint: Done
packages/chain lint: Done
packages/create-app lint: Done
packages/build-cli lint: Done
exit 0
```

The first build-system CI pass exposed that formatting drift:

```text
//packages/platform-browser:fmt  failed  970ms
Found 1 not formatted file. Run dprint fmt to fix.
411 targets: 0 hit, 410 ran, 1 failed, 0 skipped (433.9s)
```

`pnpm run circular` — pass:

```text
packages/evals circular: Done
packages/create-app circular: Done
packages/chain circular: Done
packages/build-cli circular: Done
exit 0
```

`pnpm exec smithers-build query '//...'` — pass:

```text
targets[496]:
edges[112]{from,to,kind}:
warnings: []
```

`pnpm exec smithers-build graph '//...'` — pass:

```text
targets[496]:
edges[112]{from,to,kind}:
warnings: []
```

`pnpm exec smithers-build lint '//:ci'` — pass:

```text
1 targets: 0 hit, 1 ran, 0 failed, 0 skipped (40ms)
ok: true
```

`pnpm exec smithers-build lint '//:tsconfig'` — pass:

```text
1 targets: 0 hit, 1 ran, 0 failed, 0 skipped (19ms)
ok: true
```

`pnpm exec smithers-build lint '//:knownFiles'` — pass:

```text
1 targets: 0 hit, 1 ran, 0 failed, 0 skipped (6.2s)
ok: true
```

`pnpm exec smithers-build ci '//packages/...'` — pass on the clean rerun:

```text
411 targets: 94 hit, 317 ran, 0 failed, 0 skipped (414.2s)
counts:
  hit: 94
  ran: 317
  failed: 0
  skipped: 0
ok: true
```

`pnpm exec smithers-build test '//scripts/...'` — pass:

```text
74 targets: 0 hit, 74 ran, 0 failed, 0 skipped (85.9s)
counts:
  hit: 0
  ran: 74
  failed: 0
  skipped: 0
ok: true
```

`pnpm docs:llms`, `node scripts/check-docs.mjs`, and `node scripts/check-llms.mjs` — pass after regenerating merged-tree drift:

```text
full       131 pages  1,979,910 bytes
12 artifact(s) written, 4 changed.
✓ the sidebar reaches all 132 routes the site publishes
✓ every stated package count matches the 40 published packages
✓ 12 documentation artifact(s) are current
```

`pnpm --filter @smthrs/targets test` — pass:

```text
Test Files  60 passed (60)
Tests  1346 passed (1346)
Statements   : 99.04% (7555/7628)
Branches     : 97.19% (5371/5526)
Functions    : 99.25% (1198/1207)
Lines        : 99.45% (6706/6743)
```

`pnpm --recursive --if-present --no-bail run test` — all packages completed; the examples package failed only in the two explicitly allowed pre-existing tests:

```text
FAIL test/12-agent-live-smoke.test.ts
Error: Test timed out in 30000ms.

FAIL test/18-approval-and-signal.test.ts
Expected: "/control/ClaimLost"
Received: "/control/PlanDenied"

Test Files  2 failed | 34 passed (36)
Tests  2 failed | 59 passed (61)
```

Contention checks:

- `packages/build/infra` passed in the recursive run: `15 passed (15)`, `224 passed (224)`, 100% coverage.
- `packages/observability` passed in the recursive run: `12 passed (12)`, `64 passed (64)`, 100% coverage.
- `packages/ui` passed in the recursive run: `1234 pass`, `0 fail`.
- A separate concurrent `apps/ui` package run hit two wall-clock/render-count flakes under load: `TargetGraphBlocking.test.ts` observed `69.667ms` against `<60ms`, and `ComposerHotPath.test.tsx` observed 14 renders against 10. Both passed immediately in isolation:

```text
bun test src/bun/TargetGraphBlocking.test.ts
3 pass
0 fail

bun test src/mainview/state/ComposerHotPath.test.tsx
7 pass
0 fail
```

- The specifically named native-main contention test also passed in isolation:

```text
bun test src/bun/Main.test.ts
10 pass
0 fail
34 expect() calls
```

## Remaining work

No lane work remains. The two allowed example failures remain unchanged and are recorded above.

# Repository federation decision

**Status:** Decision proposed

**Date:** 2026-08-17

**Issue:** [#1448](https://github.com/smithersai/smithers/issues/1448)

## Decision

Do not execute the proposed ten-repository split now. Keep Smithers as one
monorepo and treat the existing federation assets as a migration experiment,
not an approved migration plan.

The split is mechanically possible, but the current code is not organized as
ten independently changing products. The manifest graph contains three runtime
cycles, the candidate boundaries turn 90 runtime workspace package edges into
registry edges, and 30 of the most recent 100 merged PRs touched more than one
candidate repository boundary. The most coupled proposed extraction,
`smithers-packs`, has 544 source import references back into the retained core
alone.

Reconsider the decision when all of these conditions are true:

1. The runtime package graph is acyclic across the proposed repository
   boundaries. In particular, extension packages no longer depend on the
   `smthrs` facade and the facade/CLI/testing cycle is gone.
2. Every proposed repository installs, builds, typechecks, and tests from a
   clean checkout using released semver dependencies, without aggregate-local
   source reads, copied live sources, or `workspace:*` rewrites.
3. One release coordinator has completed a no-publish rehearsal and a canary
   release, including rollback of a partially published wave.
4. The trailing-100-PR multi-boundary rate is below 15%, or maintainers
   explicitly accept that at least the observed 30% of changes become
   coordinated multi-PR work.

Until then, package ownership and enforced import boundaries give most of the
organizational benefit without invalidating open work or making atomic changes
impossible.

## What the previous federation attempt learned

The prior work is substantial and should not be repeated. `TODO.md` and the 15
`federation-*` hardening workflows record an exact 8,835-path ownership
manifest at source commit `505717d175d5ef51b3b164aba5cbe969f805e2fe`, a
7-edge initial release DAG, a 14-edge future DAG, 193 static import occurrences,
224 dynamic reads, and 174 files that would have to be created during the
split. Those created files include 90 init-pack support copies and 29 UI copies;
the audit also found 31 direct preload importers and 257 symlinks that needed
materialization or validation.

The repeated hardening passes found the important failure mode: this is not a
directory extraction. The repository root currently supplies package ranges,
two lockfiles, generated declarations, pack assets, source-tree fixtures,
dynamic filesystem reads, UI bundles, docs, tests, and release ordering to many
lanes. Making a lane standalone required copies plus drift guards, transitional
dual carriage, aggregate-only paths, and staged semver rewrites. The proposed
release graph could be made acyclic only by treating already-published core
packages as external prerequisites, deferring packages such as
`@smthrs/review`, and publishing the facade last.

It did not land because the final standalone review was still not approvable.
The unresolved items were standalone `workspace:*` rewrites, the Telegram
workspace shape, OpenClaw transitional copies, drift guards, mandatory symlink
gates, and launch synchronization with `awesome-smithers`. The run was paused
before its mutation gate. No destination repository, migration PR, or release
was created. That was the correct stopping point: the artifacts proved
feasibility, but also proved that the operational boundary was not yet a clean
source boundary.

## Method

The dependency graph below was regenerated from the current checkout, not from
the old federation artifacts.

- All 76 distinct named `package.json` manifests under the root, `packages/*`,
  `apps/*`, `e2e`, `.smithers`, and the nested OpenClaw plugin were read.
- Runtime edges are workspace packages named in `dependencies`,
  `peerDependencies`, or `optionalDependencies`. Dev edges are workspace
  packages named only in `devDependencies`.
- A TypeScript-AST scan of the same package-owned sources found 2,243 bare
  workspace import references forming 236 package pairs. Under the candidate
  mapping below, 985 references and 92 observed package pairs cross a proposed
  repository boundary.
- A separate relative-import resolution pass found 13 cross-package pairs. The
  production exception is `apps/signal` reading
  `.smithers/lib/daily-ceo-intel`; the others are repository-level tests,
  fixtures, or release tooling.
- `pnpm check:deps` passed. It validates that bare runtime and dev imports are
  declared, but intentionally does not make repository-level test fixtures or
  dynamic filesystem reads into public APIs.

Direction in every graph is **consumer -> dependency**.

## Current package dependency graph

There are 241 unique runtime workspace edges and 306 unique edges when dev-only
dependencies are included. The table is the manifest graph; `—` means no
workspace dependency in that class. The root aggregation manifest is included
because its dev graph drives builds and releases.

| Package | Candidate owner | Runtime workspace dependencies | Additional dev-only workspace dependencies |
| --- | --- | --- | --- |
| `@smithers/openclaw-plugin` | plugins | — | — |
| `@smthrs/accounts` | core | errors | — |
| `@smthrs/agent-eliza` | agents | agents, `smthrs` | — |
| `@smthrs/agents` | agents | accounts, driver, errors, observability, usage | — |
| `@smthrs/automate-site` | examples | — | — |
| `@smthrs/aws` | sandboxes | errors, sandbox | — |
| `@smthrs/bug-worker` | core | — | — |
| `@smthrs/cli` | core | accounts, agents, components, db, devtools, driver, engine, errors, graph, herdr, memory, observability, openapi, protocol, review, scheduler, scorers, server, time-travel, tui, usage, vcs, `smthrs` | — |
| `@smthrs/cloudflare` | sandboxes | sandbox | db |
| `@smthrs/components` | core | agents, db, driver, errors, graph, memory, observability, react-reconciler, scheduler | — |
| `@smthrs/control-plane` | plue | errors | — |
| `@smthrs/daytona` | sandboxes | errors, sandbox | — |
| `@smthrs/db` | core | errors, graph, observability, scheduler | — |
| `@smthrs/ddd-site` | core | — | — |
| `@smthrs/devtools` | core | — | — |
| `@smthrs/driver` | core | db, errors, graph, observability, scheduler | — |
| `@smthrs/e2e` | core | db, driver, engine, gateway, gateway-client, observability, sandbox, scheduler, server, testing, time-travel, vcs, `smthrs` | errors |
| `@smthrs/electric-proxy` | plue | gateway | — |
| `@smthrs/engine` | core | agents, components, db, driver, errors, graph, observability, react-reconciler, sandbox, scheduler, scorers, time-travel, tool-context, vcs | — |
| `@smthrs/errors` | core | — | — |
| `@smthrs/ferric-site` | examples | — | — |
| `@smthrs/gateway` | core | protocol | — |
| `@smthrs/gateway-client` | multi | electric-proxy, gateway, protocol, usage | db, `smthrs` |
| `@smthrs/gateway-react` | multi | gateway-client | db, server |
| `@smthrs/gateway-ui` | multi | gateway-client, gateway-react, ui, ui-styleguide | — |
| `@smthrs/gcp` | sandboxes | errors, sandbox | — |
| `@smthrs/graph` | core | errors | — |
| `@smthrs/herdr` | core | — | — |
| `@smthrs/init-site` | examples | — | — |
| `@smthrs/integrations` | integrations | components, db, engine, errors, observability, react-reconciler, scheduler | — |
| `@smthrs/jj-darwin-arm64` | core | — | — |
| `@smthrs/jj-darwin-x64` | core | — | — |
| `@smthrs/jj-linux-arm64` | core | — | — |
| `@smthrs/jj-linux-x64` | core | — | — |
| `@smthrs/jj-win32-x64` | core | — | — |
| `@smthrs/kimi-benchmarks-site` | examples | — | — |
| `@smthrs/memory` | core | db, errors, graph, observability, scheduler | — |
| `@smthrs/microsandbox` | sandboxes | errors, sandbox | — |
| `@smthrs/monitor-site` | examples | — | — |
| `@smthrs/observability` | observability | — | — |
| `@smthrs/openapi` | core | errors, observability, scheduler | — |
| `@smthrs/openclaw-site` | examples | — | — |
| `@smthrs/pi-plugin` | plugins | agents, cli, devtools, errors, protocol | — |
| `@smthrs/plugins-site` | examples | — | — |
| `@smthrs/protocol` | core | — | — |
| `@smthrs/quota-dashboard` | core | usage | — |
| `@smthrs/react-reconciler` | core | devtools, driver, errors, graph | — |
| `@smthrs/review` | review | agents, db, engine, ui-styleguide, `smthrs` | — |
| `@smthrs/sandbox` | sandboxes | db, driver, errors, observability, scheduler | — |
| `@smthrs/scheduler` | core | errors, graph | — |
| `@smthrs/scorers` | core | agents, db, errors, graph, observability, scheduler | — |
| `@smthrs/self-healing-site` | examples | — | — |
| `@smthrs/server` | core | accounts, components, db, devtools, driver, engine, errors, gateway, graph, integrations, observability, protocol, scheduler, time-travel, ui-styleguide, usage | — |
| `@smthrs/signal` | signal | `smthrs` | — |
| `@smthrs/smithers-ui` | multi | gateway-client, gateway-react, gateway-ui, ui | `smthrs` |
| `@smthrs/status-site` | examples | — | — |
| `@smthrs/storybook-site` | examples | ui | — |
| `@smthrs/telegram` | integrations | — | — |
| `@smthrs/telegram-site` | examples | — | — |
| `@smthrs/telegram-summary` | integrations | gateway-ui | — |
| `@smthrs/testing` | core | components, db, driver, engine, graph, herdr, react-reconciler, scheduler, `smthrs` | — |
| `@smthrs/time-travel` | core | db, driver, errors, graph, observability, react-reconciler, scheduler, vcs | — |
| `@smthrs/tool-context` | core | — | — |
| `@smthrs/tui` | core | gateway-client, gateway-react, tui-ui, ui-core | — |
| `@smthrs/tui-ui` | core | — | — |
| `@smthrs/ui` | multi | ui-styleguide | — |
| `@smthrs/ui-core` | multi | gateway-client, gateway-react | — |
| `@smthrs/ui-site` | examples | — | — |
| `@smthrs/ui-styleguide` | multi | — | — |
| `@smthrs/usage` | core | accounts | — |
| `@smthrs/vcs` | core | observability and five optional `@smthrs/jj-*` binaries | — |
| `@smthrs/vercel` | sandboxes | errors, sandbox | — |
| `@smthrs/xstate` | core | errors, react-reconciler | db, driver, engine, time-travel, `smthrs` |
| `smithers-workflows` | packs | accounts, cli, components, gateway-client, review, scorers, usage, vcs, `smthrs` | driver, gateway-react, gateway-ui, graph |
| `smthrs` | core | agents, aws, cli, cloudflare, components, control-plane, daytona, db, driver, engine, errors, gateway-client, gateway-react, gateway-ui, gcp, graph, memory, microsandbox, observability, openapi, react-reconciler, sandbox, scheduler, scorers, server, telegram, testing, time-travel, tool-context, ui, vcs, vercel, xstate | — |
| `smithers-monorepo` | core aggregate | — | 50 workspace packages |

### Cycles and chokepoints

The runtime graph has one strongly connected component:
`@smthrs/cli`, `@smthrs/review`, `@smthrs/testing`, and `smthrs`. Its simple
cycles are:

- `@smthrs/cli -> smthrs -> @smthrs/cli`
- `@smthrs/testing -> smthrs -> @smthrs/testing`
- `@smthrs/cli -> @smthrs/review -> smthrs -> @smthrs/cli`

Adding dev edges grows that component to ten packages by including
gateway-client, gateway-react, gateway-ui, tui, ui-core, and xstate. A release
plan can sequence around those cycles by using old published versions, but it
does not remove the architectural cycle.

The runtime chokepoints by number of direct workspace consumers are errors
(26), observability (16), scheduler (15), db (14), graph (13), driver (11),
sandbox (9), agents (8), and gateway-client (8). The facade is a different kind
of chokepoint: it has 33 outgoing runtime workspace dependencies and is itself
consumed by seven workspace packages. The CLI has 23 outgoing runtime workspace
dependencies. Those two aggregation packages make a source split and a release
split inseparable today.

### Cross-boundary source reads not represented by package APIs

The relative-import scan found these repository-level couplings:

- Signal has three production/test references to
  `.smithers/lib/daily-ceo-intel/{cloudflare,render}`.
- E2E reaches CLI scheduler code, devtools internals, testing source, TUI test
  fixtures, facade test helpers, and a root packaging script.
- Root scripts reach Nanocodex agent internals and testing source.
- Pack tests reach CLI source, a components implementation constant, and a
  gateway-react test fixture.
- The CLI reaches its nested OpenClaw package source.

The previous dynamic-read audit found the larger form of the same problem:
pack generation, UI bundling, docs/d.ts/UI checks, coverage, release scripts,
CLI tests, server UI bundling, examples, benchmarks, and eval harnesses all
resolve files by repository path. These are contracts even though the package
manifest graph cannot see them.

## Candidate repository boundaries

The table uses the issue's proposed boundaries. “Versioned edges” names current
workspace package relations that would become registry dependencies; dynamic
or file contracts are called out separately.

| Repository | What moves | Public contract after a split | Existing edges that become versioned or external |
| --- | --- | --- | --- |
| Smithers core | Runtime/control-plane packages, CLI, server, facade, TUI, tests, docs, release coordinator | Versioned core packages; facade remains compatibility/meta package and publishes last | Depends on agents, integrations, multi UI packages, observability, review, sandbox packages, and plue control-plane. Every reverse edge below also pins a core release. |
| `smithers-agents` | agents and agent-eliza packages; agent-specific fixtures/docs | `@smthrs/agents` and `@smthrs/agent-eliza`; capability/adapter APIs only | agents -> accounts, driver, errors, usage, observability; agent-eliza -> facade. Core has five runtime package edges back to agents. |
| `smithers-sandboxes` | sandbox plus aws/cloudflare/daytona/gcp/microsandbox/vercel providers | Base sandbox/provider kit and separately versioned providers | Providers/base -> errors, db, driver, scheduler, observability. Core engine/e2e/facade have nine runtime edges back. |
| `smithers-integrations` | integrations, telegram, telegram-summary | Versioned integration components and Telegram API/app | integrations -> six core packages plus observability; telegram-summary -> gateway-ui. Core server/facade have two edges back. |
| `smithers-plugins` | pi-plugin, OpenClaw plugin, Claude/Codex plugin assets | Plugin packages plus a documented CLI protocol/capability contract | pi-plugin -> agents, cli, devtools, errors, protocol. OpenClaw currently ships as nested CLI source, so installation must consume a package artifact first. |
| `smithers-packs` | Reusable `.smithers` workflows, prompts, components, UIs, and pack tests; exclude repo-local state/specs/migration machinery | A versioned pack artifact and schema; CLI discovers/installs it instead of reading source | Nine runtime package dependencies, including core, multi, and review; 544 pack -> core bare-import references. CLI generation/discovery is an unversioned reverse file contract today. |
| `smithers-observability` | apps/observability | `@smthrs/observability` event, metric, logging, and tracing API | Leaf package, but 16 direct runtime consumers: 13 in core plus agents, integrations, and sandboxes. This is the cleanest package graph but a high-frequency change boundary. |
| `smithers-review` | apps/review | `@smthrs/review`, depending only on concrete engine/agent/UI APIs | review -> agents, db, engine, ui-styleguide, facade; CLI -> review. The facade dependency participates in the runtime cycle. |
| `smithers-evals` | eval suites, harnesses, and benchmarks | Versioned suite/case schema and a CLI runner protocol; datasets as released assets | Not a workspace package today. Harnesses execute CLI and pack paths dynamically, so the first contract is an asset/runner interface rather than npm package edges. |
| `smithers-signal` | apps/signal and its owned config/deploy assets | Private deployable consuming released facade and a published CEO-intel library/config schema | signal -> facade; production code also reaches the pack's daily-ceo-intel cloudflare/render source by relative path. |
| `smithers-examples` | examples and technical example/demo sites | No required npm publication; examples pin supported released package versions | Storybook site -> ui. The broader examples tree consumes facade, agents, observability, packs, and test fixtures outside a manifest-owned workspace. |
| `multi` history lane | smithers browser app and gateway-client/react/ui/ui-core/ui-styleguide/gateway-ui | Versioned gateway wire client, React hooks, headless UI state, and visual UI packages | multi -> gateway/protocol/usage/electric-proxy; core facade/TUI/server/e2e have nine runtime edges back. Review, integrations, packs, and examples also consume UI packages. |
| `plue` history lane | control-plane and electric-proxy | Hosted control-plane and Electric proxy packages over stable gateway/errors contracts | plue -> gateway/errors; facade and gateway-client depend back on plue packages. |

Across that mapping there are 90 current runtime manifest package pairs crossing
repository boundaries. Every one changes from an atomic workspace edge to a
published-version edge. The boundary graph itself is cyclic: core <-> agents,
core <-> sandboxes, core <-> integrations, core <-> multi, core <-> plue, and
core <-> review are all bidirectional.

## Change-frequency cost

The last 100 merged PRs, merged from 2026-07-26 through 2026-08-17, were
classified by changed path against the candidate ownership above. Root files,
docs, CI, retained packages, and release tooling count as core because that is
where they would remain under the proposed plan. `.smithers/**` counts as packs
for this conservative measurement; a curated split would move fewer files, but
the CLI's reverse file dependencies would still be cross-repository contracts.
Three PR file lists were truncated by the list API at 100 files, but all three
were already classified as multi-boundary, so the headline result is exact.

**30 of the last 100 merged PRs touched more than one candidate repository
boundary.** Thirteen touched at least two proposed extracted lanes even after
ignoring core. Examples include the generic checkpoint work (#1449: agents,
core, examples, packs), Effect 4 compatibility (#1467: core, integrations,
observability, sandboxes), cancellation state (#1601: core, multi,
observability, packs), and token-usage contracts (#1570: agents, core,
examples, multi, packs).

That is the expected multi-PR tax, not an edge case. A cross-boundary change
needs an upstream contract PR and release, downstream range/lockfile PRs, and an
aggregate verification pass. Temporary compatibility code makes the sequence
longer when deployment or publication order matters. A regression bisect also
becomes a search over version combinations instead of one commit order.

## CI, documentation, and release cost

The current CI is a shared product contract, not merely repeated package tests:

- Six runtime-conformance lanes cover Browser, Cloudflare Workers, Vercel,
  Node.js, Node.js CLI, and Bun.
- Typecheck runs on Linux and Windows. Tests use three Linux package shards
  plus an extras shard and four Windows shards, plus a separate whole-workspace
  coverage job.
- Root gates enforce one Effect version, npm deduplication, dependency
  declarations, UI architecture and its baseline ratchet, docs/source
  agreement, generated llms bundles, workflow test registration, and release
  behavior.
- The declaration freshness gate rebuilds 16 packages in place and compares
  committed `.d.ts` files.
- Releases refresh and commit both `pnpm-lock.yaml` and `bun.lock`, keep all
  public package versions aligned, rebuild declarations, regenerate versioned
  docs bundles, and publish the workspace as one operation.

A split must choose explicitly between duplication and centralization. Copying
these gates into every repository creates drift and multiplies CI cost;
centralizing them makes the root aggregate repository a required integration
gate and preserves much of the coordination the split was meant to remove.
Runtime conformance, docs bundles, and UI architecture cannot honestly be
assigned to one leaf repository because they assert behavior across several
candidate boundaries.

Release coordination also becomes stricter. The old federation attempt's
“publish facade last” rule is necessary but insufficient while consumers depend
on the facade and the facade depends back on them. Using the previous release
to break a cycle can make publication succeed, but it allows source and package
graphs to describe different systems. Partial publication requires an explicit
resume/rollback protocol and a tested compatibility window for every edge in a
wave.

## Groundwork assessment

No source change is justified independently of the split in this pass.
`pnpm check:deps` is green, and the remaining cross-package relative reads are
not safe mechanical rewrites:

- Most are deliberate repository-level E2E, release, or fixture checks. Turning
  test helpers into public package exports solely for a possible split would
  enlarge the supported API.
- The real production violation, Signal importing daily-ceo-intel internals,
  has two owners today. Moving it into either side reverses the dependency for
  the other; copying it recreates the drift-guard problem found by the prior
  attempt. It needs an ownership/API decision, not a path edit.
- Removing facade dependencies from CLI, testing, review, and agent-eliza is
  valuable, but it changes public construction and type contracts. That should
  be a separately reviewed architecture project with compatibility tests.

The safe groundwork is therefore the decision itself: make the maintainer
choose a target dependency direction before code is moved.

## Question required to close #1448

Does the maintainer accept a federated system in which roughly 30% of recent
changes require coordinated releases and the root aggregate remains the
authoritative CI/release gate, or should Smithers keep the monorepo and invest
instead in eliminating facade cycles and enforcing package ownership? The
recommendation is the latter. If federation is still desired, approve a staged
proof with one leaf boundary only after naming which repository owns the
cross-repository contracts and release coordinator.

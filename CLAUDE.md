# Smithers

Durable-execution engine and control plane for long-running coding agents. A
flow is a typed Effect program whose side effects are journaled as they happen;
the next process reads the journal and continues where the record stops.

`AGENTS.md` is a symlink to this file; edit this file.

## Migration in progress

This tree is mid-migration to `1.0.0-rc.0`. Read these before changing
anything structural:

- `PLAN.md` — the seven phases and their exit criteria.
- `docs/migration/rc-contract.md` — the frozen release contract. Section 9 is
  the tooling baseline; the imported Flows tooling wins unless section 9 names
  an exception.
- `docs/migration/disposition-ledger.md` (and `.json`) — one recorded
  disposition per old path.
- `docs/migration/phase2-baseline.md` — the post-import gate baseline.

`legacy/` holds 0.x sources that later phases port from. It is excluded from
the workspace, `tsconfig.json`, eslint, vitest, and every package-mode inventory,
and live code must never import it. `pnpm run check:legacy-absent` is the
Phase 7 gate that fails while the directory exists.

## Find things

Engine and durability:

- `packages/{flow,engine,engine-store}` — authoring model, runtime, durable engine.
- `packages/{journal,run-store,step-cache,plan,artifacts,database}` — the storage ladder.
- `packages/{canonical,crypto,keys}` — canonical JSON, injected crypto, flow keys.
- `packages/{capability,kernel}` — capability vocabulary and the guarded host surface.
- `packages/{sync,time-travel}` — follower replication; replay, fork, rewind, compensate.
- `packages/flows` — the curated aggregate barrel and `NodeRuntime` composition.

Control plane, agents, and clients:

- `packages/{cli,control,gateway}` — the `smithers` executable, control services, gateway projections.
- `packages/{agent,harness,model,mcp,memory,notifications,registry}` — agent loop, cell runtime, model routes, MCP, durable memory, notifications, flow discovery.
- `packages/{core,patterns,plugin,std,testing}` — plan-time builders, higher-order patterns, plugin kernel, standard tools, test doubles and conformance suites.
- `packages/{chain,evals,scorers,triggers,fs}` — private agent-group packages.
- `packages/{ui,ui-styleguide}` — 0.x UI kits retained for `apps/ui` and `apps/review`; private at rc.0.

Hosts and adapters:

- `packages/{platform-node,platform-bun,platform-browser}` — host bundles.
- `packages/{jj,sandbox,observability}` — Jujutsu host service, remote spawner, OTLP wiring.
- `crates/flows-jj` + `vendor/jj` — the Rust crate and the pinned jj submodule behind `packages/jj/wasm/flows_jj.wasm`.

Build system and repository surfaces:

- `packages/{build,build-cli,targets}` and `packages/build/infra` — the target graph, its CLI, and the hosted cache Worker.
- `.smithers/WORKSPACE.ts` — runtime, package manager, node modules, host tools, agents, hooks, and nested repository boundaries.
- `PACKAGE.ts`, `packages/*/PACKAGE.ts`, `apps/*/PACKAGE.ts`, `evals/*/PACKAGE.ts`, `examples/PACKAGE.ts`, `factory/PACKAGE.ts`, `scripts/PACKAGE.ts`, `crates/flows-jj/PACKAGE.ts` — target declarations.
- `scripts/` — release, gate, and operator scripts, each declared in `scripts/PACKAGE.ts`.
- `apps/{ui,server,shared,tui}` — the product UI, its Worker, shared code, and the terminal UI.
- `apps/{bug-worker,status-site}` — deployed operational endpoints.
- `examples/`, `evals/`, `factory/` — runnable documentation programs, eval suites, factory queue.
- `docs/pages` — the vocs documentation site; `vocs.config.ts` configures it.

Workflow automation:

- `workflows/lints` — diff-scoped agent judgment rules.
- `workflows/gates` — deterministic repository gate scripts.
- `workflows/{wave-reconciliation,effect-bump,new-agent-adapter,ci-red-triage}` — the four agent lanes and their typed package targets.
- `WORKFLOW-CANDIDATES.md` — the ranked evidence and backlog for workflow automation.

## Commands

```sh
pnpm install --frozen-lockfile --offline
pnpm run check                    # tsc across every package
pnpm test                         # vitest/bun across every package
pnpm run lint                     # eslint + dprint
pnpm run circular                 # madge
pnpm run browser                  # browser bundle contract
pnpm run test:examples
pnpm run test:jsdoc
pnpm exec vocs dev                # docs site

pnpm exec smithers-build query '//...'                              # list the 600 package-mode labels
pnpm exec smithers-build graph '//...'                              # print the package-mode graph
pnpm exec smithers-build target '//packages/canonical:check' --plan # plan one label
pnpm exec smithers-build test '//:gates'                            # run the repository gates
pnpm exec smithers-build build '//packages/canonical:lib'           # build one package
pnpm exec smithers-build lint '//packages/canonical:lint'           # lint one package
pnpm exec smithers-build target '//:githubCi' --write               # regenerate declared CI workflows
pnpm exec smithers-build gitHooks                                   # check generated git hooks
```

Package mode serves `query`, `graph`, `target <label> [--plan]`, `test`,
`build`, `lint`, and `gitHooks`. The `ci`, `docs`, and `install` verbs refuse.

`pnpm test` stops at the first failing package. Use
`pnpm --recursive --if-present --no-bail run test` to see every package.

The build CLI's binary is `smithers-build` (private `packages/build-cli`). The
user-facing binary is `smithers`, owned by `packages/cli`, and it runs the
working tree: `packages/cli/bin/smithers.mjs` executes `dist/esm/bin.js` when a
published install has one and `src/bin.ts` otherwise, so `pnpm exec smithers`
needs no build step.

## Invariants

- Every `PACKAGE.ts` exports exactly one `Package` map and declares targets,
  never load-time commands. A gate becomes a target in the package that owns
  it before CI can run it. `CONTRIBUTING.md` has the full rule.
- `.smithers/WORKSPACE.ts` is the workspace declaration. Add every nested
  workspace to its `repos` map or discovery throws
  `nested_workspace_undeclared`.
- Files generated by package-mode targets, including `known-files.d.ts`,
  `tsconfig.json`, and generated GitHub workflows, are regenerated and never
  hand-edited. Their pins in
  `packages/flows/test/vitestCoverageIsolation.test.ts` change in the same
  commit. `pnpm-workspace.yaml` remains hand-written and authoritative.
- Exactly one `effect` version resolves across every manifest and both
  lockfiles: `4.0.0-rc.108`. `scripts/check-single-effect-version.mjs` enforces it.
- Dependency and package-manifest changes refresh both `pnpm-lock.yaml` and
  `bun.lock` in the same commit. Package-mode targets run Bun across apps,
  evals, factory, and the declared package compatibility suites.
- The durable engine runs on Node.js >= 22.19.0 with local SQLite. Bun covers
  only the package-mode compatibility targets. PostgreSQL and PGlite are
  unsupported.
- Product code and end-to-end tests use real backends and real data, never
  mocked behavior.
- Use `jj st` / `jj diff` for working-copy truth where a jj workspace exists.
  Preserve unrelated concurrent changes; never blanket-stage.
- `legacy/` is never imported by live code and never enters a tooling inventory.

## Replies

- Be extremely concise. Minimum words to convey the point. Long replies go unread.
- Lead with the answer or result. No preamble, no recap of what you just did.
- Do the work instead of asking permission or listing options.

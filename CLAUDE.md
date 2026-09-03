# Smithers

Durable-execution engine and control plane for long-running coding agents. A
flow is a typed Effect program whose side effects are journaled as they happen;
the next process reads the journal and continues where the record stops.

`AGENTS.md` is a symlink to this file; edit this file.

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
- `BUILD.ts`, `ci/BUILD.ts`, `lint/BUILD.ts`, `scripts/BUILD.ts`, `apps/*/BUILD.ts`, `packages/*/BUILD.ts` — target declarations.
- `scripts/` — release, gate, and operator scripts, each declared in `scripts/BUILD.ts`.
- `apps/{ui,server,shared,tui}` — the product UI, its Worker, shared code, and the terminal UI.
- `apps/{bug-worker,status-site}` — deployed operational endpoints.
- `examples/`, `evals/`, `factory/` — runnable documentation programs, eval suites, factory queue.
- `docs/pages` — the vocs documentation site; `vocs.config.ts` configures it.

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

pnpm exec smithers-build ci '//packages/...'      # the whole package graph
pnpm exec smithers-build test '//scripts/...'     # the script gates
pnpm exec smithers-build build '//:ci'            # regenerate .github/workflows/ci.yml
pnpm exec smithers-build lint '//:ci'             # drift-check that workflow
```

`pnpm test` stops at the first failing package. Use
`pnpm --recursive --if-present --no-bail run test` to see every package.

The build CLI's binary is `smithers-build` (private `packages/build-cli`). The
user-facing binary is `smithers`, owned by `packages/cli`, and it runs the
working tree: `packages/cli/bin/smithers.mjs` executes `dist/esm/bin.js` when a
published install has one and `src/bin.ts` otherwise, so `pnpm exec smithers`
needs no build step.

## Invariants

- `BUILD.ts` declares targets, never commands. A gate becomes a target in the
  package that owns it before CI can run it. `CONTRIBUTING.md` has the full rule.
- Root files generated from `BUILD.ts` (`tsconfig.json`, `.github/workflows/ci.yml`,
  `known-files.d.ts`) are regenerated, never hand-edited, and their pins in
  `packages/flows/test/vitestCoverageIsolation.test.ts` change in the same commit.
  `pnpm-workspace.yaml` is the exception: pnpm owns it and it is hand-written.
- Exactly one `effect` version resolves across every manifest and both
  lockfiles: `4.0.0-rc.108`. `scripts/check-single-effect-version.mjs` enforces it.
- Dependency and package-manifest changes refresh both `pnpm-lock.yaml` and
  `bun.lock` in the same commit. Bun runs `apps/*`, the `ci/BUILD.ts` matrix,
  and `evals/agent`.
- The durable engine runs on Node.js >= 22.19.0 with local SQLite. Bun covers
  only the matrix in `ci/BUILD.ts`. PostgreSQL and PGlite are unsupported.
- Product code and end-to-end tests use real backends and real data, never
  mocked behavior.
- Use `jj st` / `jj diff` for working-copy truth where a jj workspace exists.
  Preserve unrelated concurrent changes; never blanket-stage.

## Replies

- Be extremely concise. Minimum words to convey the point. Long replies go unread.
- Lead with the answer or result. No preamble, no recap of what you just did.
- Do the work instead of asking permission or listing options.

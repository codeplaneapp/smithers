# 04: custom TUIs, the .smithers/tui contract

`.smithers/tui/<workflowKey>.tsx` is the terminal twin of `.smithers/ui/<workflowKey>.tsx`. Same key (the workflow file basename, not the display name), same self-containment rule, same seeding pipeline, plus a user preference for which surface opens by default.

## The GUI contract we mirror (verified mechanics)

- Resolution: the gateway resolves a workflow's UI as either an explicit `<UI entry>` declaration or, by convention, `dirname(entryFile)/../ui/<workflowKey>.tsx`, re-checked on every call (`Gateway.resolvedUiFor`, `packages/server/src/gateway.js`), so a file created while the gateway runs becomes servable with no restart. Bundled on demand by `Bun.build` (`packages/server/src/gatewayUi/bundle.js`).
- `smithers ui [runId]` (`apps/cli/src/index.js`, `runUiCommand`): resolve/autostart a gateway; derive the workflow key from the run via `workflowKeyForUiRun` (prefers `configJson.gatewayWorkflowKey`, then `run.workflowKey`, then `workflowIdFromPath`); on a registry miss, HEAD `/workflows/<key>` triggers a registry refresh; open `${base}${uiPath}?runId=<id>`; fail with `NO_UI` naming the missing `.smithers/ui/<key>.tsx`.
- Self-containment: enforced at pack-generation time only, by `scripts/generate-workflow-pack.ts` `uiRelativeImportsOf` (throws when a static or dynamic relative import escapes `.smithers/ui/`; tests excluded). There is no runtime validator; locally authored escaping imports still bundle. The scorer `packages/scorers/src/workflowUiCompliance.js` grades UI sources separately.
- Seeding: `generate-workflow-pack.ts` reads `.smithers/{workflows,prompts,lib,ui,spec}`, walks the import closure, and emits `apps/cli/src/seeded-workflow-pack.generated.js` (`GENERATED_SEEDED_FILES`) which `smithers init` writes verbatim. Curated lists: `SEEDED_WORKFLOW_IDS` (10 workflows) and `SEEDED_UI_IDS` (4 with real multi-file UIs: create-workflow, create-skill, docs-driven-development, share-pack); the rest get the generic template. It runs `checkUiArchitecture` first and refuses to generate on failure.

## The TUI contract

### Module shape

`.smithers/tui/<key>.tsx` is a self-contained opentui + React module:

- `/** @jsxImportSource @opentui/react */` (NOT plain react, NOT smithers-orchestrator).
- Imports allowed: `react`, `@opentui/core`, `@opentui/react`, `@smithers-orchestrator/tui-ui`, `@smithers-orchestrator/ui-core`, `@smithers-orchestrator/gateway-react` (hooks run fine under opentui; packages/tui is the proof), plus relative imports that stay inside `.smithers/tui/`.
- Boot: default-export a component `({ runId }) => JSX`. The loader owns the renderer and provider stack; custom TUIs never call `createCliRenderer` themselves. This differs from `.smithers/ui/` (where each file calls `createGatewayReactRoot` and the gateway wraps it in a page) because a terminal has exactly one renderer and the loader must keep quit keys, error boundary, and gateway wiring uniform.

### The loader: `smithers tui [runId] [--workflow <key>]`

New CLI command mirroring `runUiCommand` symmetrically:

1. Resolve gateway (autostart like `smithers ui`; same `--gateway`/`--no-autostart` flags).
2. Derive the workflow key from the run exactly like `workflowKeyForUiRun`.
3. Resolve `dirname(workflowFile)/../tui/<key>.tsx`; on a miss fail with `NO_TUI` naming the expected path (message mirrors `NO_UI`).
4. Launch the packages/tui shell in "custom TUI" mode: the shell mounts its standard providers (ErrorBoundary, RendererProvider, Keybindings, SmithersGatewayProvider bound to the resolved gateway) and renders the custom module's default export with `{ runId }`. Loading uses bun's native TSX import; no bundler needed in-process (unlike the browser path, which needs `Bun.build`).
5. Global keys stay owned by the shell: Ctrl-C/q quit, `?` help, Esc back. A custom TUI receives all other keys.

`smithers up` interactive: after starting/attaching a run, consult the preference (below) to pick `launchTuiMonitor` (generic monitor), the custom TUI when one exists, or the browser UI.

### Preference

- Config: `ui.defaultSurface: "gui" | "tui"` in `smithers.config` (workspace) with a per-user override in `~/.smithers/config`; default `gui` to preserve current behavior.
- Per-invocation: `--tui` / `--gui` flags on `up`, `ui` (opens the twin instead when `--tui`), and `tui`.
- Resolution order: explicit flag > workspace config > user config > default.

### Seeding twins

- `SEEDED_TUI_IDS` in `generate-workflow-pack.ts`, parallel to `SEEDED_UI_IDS`; closure-walk `.smithers/tui/` with a `tuiRelativeImportsOf` guard identical to `uiRelativeImportsOf` ("Seeded TUIs must be self-contained under .smithers/tui/").
- Every seeded GUI gets a TUI twin: start with the generic template (a run dashboard: header, node list, output pane, approval bar, built from tui-ui + gateway-react) for all 10 seeded workflows, then bespoke twins for the 4 bespoke GUIs.
- The pack ships `.smithers/tui/` files through `GENERATED_SEEDED_FILES` like every other pack asset.

### Repo mechanics

New CLI command checklist (verified against the check-docs gates): `docs/cli/<page>.mdx` for `smithers tui`, the command catalog + `commands[N]` count in `docs/cli/overview.mdx`, `scripts/check-docs.mjs` count bumps, `pnpm docs:llms` regen. The `tui` command flag block is unchecked by check-docs (only `workflow.run` is validated) but should still match `--schema --format json` output.

### Testing

- Contract tests (no TTY): loader resolution (key derivation, NO_TUI error, preference resolution) as pure functions in apps/cli tests.
- Seeding tests: generate-workflow-pack round-trip includes `.smithers/tui/` files and the escape guard throws on a fixture escaping import.
- zmux e2e: `smithers tui <runId>` against a seeded workflow with a seeded twin renders the twin's title; `--gui`/`--tui` preference matrix asserted via which surface a fixture `up` opens (browser launch stubbed by env, TUI observed in the pty).

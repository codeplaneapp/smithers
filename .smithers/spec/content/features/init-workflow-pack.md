# Init workflow pack and starters

> **Status:** Partial | **Priority:** P0 | **Owner:** smithers-maintainers | **Group:** Start a workflow

`smithers init` installs the local or global .smithers pack, curated skills, agent guidance, prompts, ready workflows, and per-workflow UIs; starters and workflow list expose the installed catalog.

## What you can do

Bootstrap a repository once, then run planning, implementation, review, debug, ticket, kanban, audit, and long-horizon workflows by ID.

## Capabilities

### Local and global pack install

init can scaffold .smithers locally or ~/.smithers globally, update drifted files, and install dependencies.

### Seeded workflows

The generated pack includes hello, plan, implement, review, debug, kanban, tickets-create, research, mission, audit, feature-enum, and more.

### Starter gallery

smithers starters maps plain-English intents to copy-paste workflow run commands.

### Generated pack freshness

`scripts/generate-workflow-pack.ts` is tested against the committed .smithers sources.

## Endpoints and commands

- `CLI smithers init` ([docs](docs/workflows/init.mdx))
- `CLI smithers starters` ([docs](docs/cli/overview.mdx))
- `CLI smithers workflow list` ([docs](docs/cli/overview.mdx))
- `CLI smithers workflow run <id>` ([docs](docs/cli/overview.mdx))

## Related docs

- [README get started](README.md#get-started)
- [Workflow catalog](docs/workflows/overview.mdx)
- [Starters](docs/starters.mdx)

## Test cases

- `apps/cli/tests/init.e2e.test.js`
- `apps/cli/tests/init-durable.e2e.test.js`
- `apps/cli/tests/init-installed-layout.test.js`
- `apps/cli/tests/seeded-pack-fresh.test.js`
- `apps/cli/tests/seeded-workflows-run.e2e.test.js`
- `apps/cli/tests/starter-gallery.test.js`
- `apps/cli/tests/workflow-pack-subset.test.js`

## Observability

- Init emits installed-layout and next-step output; seeded workflow smoke tests launch fake-agent runs and assert valid states.
- Workflow discovery records displayName, description, tags, aliases, sourceType, scope, and UI descriptors for `CLI/Gateway` consumers.

## Debugging

- Run `smithers workflow list` --format json to verify discovery scope and metadata.
- Run `pnpm run generate`:init-pack when source .`smithers workflow`s or UIs change, then `apps/cli/tests/seeded-pack-fresh.test.js` verifies the generated pack.

## Architecture

- `apps/cli/src/init-command.js` and `apps/cli/src/workflow-pack.js` own `install/update` behavior.
- `scripts/generate-workflow-pack.ts` seeds the built-in pack from committed .smithers sources.
- README.md and `docs/workflows/overview.mdx` describe the ready-to-run workflow families.

## Fixes and diffs

- 2026-07-06 refresh: read README.md, package exports, selected package entry points, `docs/how-it-works.mdx`, `docs/cli/overview.mdx`, `docs/agents/overview.mdx`, `docs/integrations/custom-ui.mdx`, `docs/integrations/mcp-server.mdx`, `docs/deployment/production-hardening.mdx`, `docs/deployment/control-plane.mdx`, and targeted test inventories.
- 2026-07-06 adversarial review: downgraded from fixed to partial after the cited init tests failed in the aggregate fixed-feature test run.
- `apps/cli/src/init-command.js`
- `apps/cli/src/workflow-pack.js`
- `scripts/generate-workflow-pack.ts`
- `.smithers/workflows/*.tsx`
- `.smithers/ui/*.tsx`
- `docs/workflows/*.mdx`

## Open gaps

- 2026-07-06 review: `apps/cli/tests/workflow-pack-subset.test.js` fails because subset install includes unexpected upgrade workflow in addition to selected workflow plus `init/post-failure`.
- 2026-07-06 review: `apps/cli/tests/init.e2e.test.js` workflow-pack smoke typecheck fails because seeded workflows import UI from smithers-orchestrator, but that facade export is missing.

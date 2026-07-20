# Workflow packs

> **Status:** Partial | **Priority:** P0 | **Owner:** smithers-maintainers | **Group:** Start a workflow

Install read-only workflow packs from GitHub, npm, or local files; lock and update versions; run namespaced workflows; eject editable copies; remove packs; and publish a project pack through the registry workflow.

## What you can do

Reuse and share complete workflows, prompts, libraries, and UIs without copying them into every project.

## Capabilities

### Install and lock

add accepts GitHub, npm, and file specs, validates smithers.toon, scans imports, and records resolved sources in packs.lock.toon.

### Namespaced resolution

Pack workflows run by unqualified id when unambiguous or explicit pack:workflow id; local workflows shadow only the unqualified name.

### Update and remove

packs update refreshes one or all locked packs, while remove deletes the selected installed pack and lock entry.

### Eject and share

eject copies a workflow and its imported assets into editable local paths; share prepares a registry entry and opens a GitHub pull request.

## Endpoints and commands

- `CLI smithers add <spec>` ([docs](docs/reference/packs.mdx))
- `CLI smithers packs list|update` ([docs](docs/reference/packs.mdx))
- `CLI smithers eject <pack:workflow>` ([docs](docs/reference/packs.mdx))
- `CLI smithers remove <pack>` ([docs](docs/reference/packs.mdx))
- `CLI smithers share` ([docs](docs/reference/packs.mdx))

## Related docs

- [Workflow packs](docs/reference/packs.mdx)
- [Add system workflow](docs/workflows/add.mdx)
- [Share-pack workflow](docs/workflows/share-pack.mdx)

## Test cases

- `apps/cli/tests/packs.test.js`
- `apps/cli/tests/packs-cli.e2e.test.js`
- `apps/cli/tests/packs-eject.test.js`

## Observability

- packs list reports installed versions, source specs, scopes, and lock state from packs.lock.toon.
- Durable add and share-pack system workflows expose their installation or publishing steps as ordinary run state.

## Debugging

- Use smithers packs list and inspect packs.lock.toon when a workflow resolves to an unexpected pack version.
- Use smithers eject for a local editable copy; local workflow ids intentionally shadow unqualified pack ids.

## Architecture

- `apps/cli/src/packs.js` owns spec parsing, trust checks, manifests, lockfiles, `install/update/remove/eject`, and registry sharing.
- `apps/cli/src/workflow-pack.js` seeds durable add and share-pack system workflows into initialized projects.

## Fixes and diffs

- 2026-07-18 feature and docs audit: added the shipped pack lifecycle as a first-class product feature; 30 install, lock, update, remove, eject, and CLI lifecycle tests passed.
- `apps/cli`
- `apps/cli/src/packs.js`
- `docs/reference/packs.mdx`
- `docs/workflows/add.mdx`
- `docs/workflows/share-pack.mdx`

## Open gaps

- The normal share path requires an authenticated gh CLI and a live registry repository; CI primarily proves dry-run and local repository behavior.

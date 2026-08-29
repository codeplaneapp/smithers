---
description: "Where every asset the Mintlify-era documentation left behind lives now, and how a reader reaches it."
---

# Route plan

The documentation moved from Mintlify to vocs in Smithers 1.0. Pages were
rewritten, but three families of asset were kept rather than replaced: the
release image trees, the Smithers 0.x changelogs, and the SOTA model registry.
This page says where each one is now.

It covers 90 kept assets and 36 deletion rules. The table is generated from
`docs/migration/disposition-ledger.json` and the tree itself, and `check-docs`
fails when an asset the ledger keeps has no place here or a file the ledger
deletes is still present.

## Changelogs

45 files. a vocs page in the changelogs section.

| Was | Is | Route |
| --- | --- | --- |
| `docs/changelogs/0.14.0.mdx` | `docs/pages/changelogs/0.14.0.mdx` | `/changelogs/0.14.0` |
| `docs/changelogs/0.15.0.mdx` | `docs/pages/changelogs/0.15.0.mdx` | `/changelogs/0.15.0` |
| `docs/changelogs/0.15.1.mdx` | `docs/pages/changelogs/0.15.1.mdx` | `/changelogs/0.15.1` |
| `docs/changelogs/0.16.0.mdx` | `docs/pages/changelogs/0.16.0.mdx` | `/changelogs/0.16.0` |
| `docs/changelogs/0.16.1.mdx` | `docs/pages/changelogs/0.16.1.mdx` | `/changelogs/0.16.1` |
| `docs/changelogs/0.16.2.mdx` | `docs/pages/changelogs/0.16.2.mdx` | `/changelogs/0.16.2` |
| `docs/changelogs/0.16.3.mdx` | `docs/pages/changelogs/0.16.3.mdx` | `/changelogs/0.16.3` |
| `docs/changelogs/0.16.4.mdx` | `docs/pages/changelogs/0.16.4.mdx` | `/changelogs/0.16.4` |
| `docs/changelogs/0.16.5.mdx` | `docs/pages/changelogs/0.16.5.mdx` | `/changelogs/0.16.5` |
| `docs/changelogs/0.16.6.mdx` | `docs/pages/changelogs/0.16.6.mdx` | `/changelogs/0.16.6` |
| `docs/changelogs/0.16.7.mdx` | `docs/pages/changelogs/0.16.7.mdx` | `/changelogs/0.16.7` |
| `docs/changelogs/0.16.8.mdx` | `docs/pages/changelogs/0.16.8.mdx` | `/changelogs/0.16.8` |
| `docs/changelogs/0.16.9.mdx` | `docs/pages/changelogs/0.16.9.mdx` | `/changelogs/0.16.9` |
| `docs/changelogs/0.17.0.mdx` | `docs/pages/changelogs/0.17.0.mdx` | `/changelogs/0.17.0` |
| `docs/changelogs/0.18.0.mdx` | `docs/pages/changelogs/0.18.0.mdx` | `/changelogs/0.18.0` |
| `docs/changelogs/0.19.0.mdx` | `docs/pages/changelogs/0.19.0.mdx` | `/changelogs/0.19.0` |
| `docs/changelogs/0.20.0.mdx` | `docs/pages/changelogs/0.20.0.mdx` | `/changelogs/0.20.0` |
| `docs/changelogs/0.20.1.mdx` | `docs/pages/changelogs/0.20.1.mdx` | `/changelogs/0.20.1` |
| `docs/changelogs/0.20.2.mdx` | `docs/pages/changelogs/0.20.2.mdx` | `/changelogs/0.20.2` |
| `docs/changelogs/0.20.3.mdx` | `docs/pages/changelogs/0.20.3.mdx` | `/changelogs/0.20.3` |
| `docs/changelogs/0.20.4.mdx` | `docs/pages/changelogs/0.20.4.mdx` | `/changelogs/0.20.4` |
| `docs/changelogs/0.21.0.mdx` | `docs/pages/changelogs/0.21.0.mdx` | `/changelogs/0.21.0` |
| `docs/changelogs/0.22.0.mdx` | `docs/pages/changelogs/0.22.0.mdx` | `/changelogs/0.22.0` |
| `docs/changelogs/0.23.0.mdx` | `docs/pages/changelogs/0.23.0.mdx` | `/changelogs/0.23.0` |
| `docs/changelogs/0.24.0.mdx` | `docs/pages/changelogs/0.24.0.mdx` | `/changelogs/0.24.0` |
| `docs/changelogs/0.24.1.mdx` | `docs/pages/changelogs/0.24.1.mdx` | `/changelogs/0.24.1` |
| `docs/changelogs/0.24.2.mdx` | `docs/pages/changelogs/0.24.2.mdx` | `/changelogs/0.24.2` |
| `docs/changelogs/0.25.0.mdx` | `docs/pages/changelogs/0.25.0.mdx` | `/changelogs/0.25.0` |
| `docs/changelogs/0.25.1.mdx` | `docs/pages/changelogs/0.25.1.mdx` | `/changelogs/0.25.1` |
| `docs/changelogs/0.25.2.mdx` | `docs/pages/changelogs/0.25.2.mdx` | `/changelogs/0.25.2` |
| `docs/changelogs/0.25.3.mdx` | `docs/pages/changelogs/0.25.3.mdx` | `/changelogs/0.25.3` |
| `docs/changelogs/0.25.4.mdx` | `docs/pages/changelogs/0.25.4.mdx` | `/changelogs/0.25.4` |
| `docs/changelogs/0.26.0.mdx` | `docs/pages/changelogs/0.26.0.mdx` | `/changelogs/0.26.0` |
| `docs/changelogs/0.26.1.mdx` | `docs/pages/changelogs/0.26.1.mdx` | `/changelogs/0.26.1` |
| `docs/changelogs/0.27.0.mdx` | `docs/pages/changelogs/0.27.0.mdx` | `/changelogs/0.27.0` |
| `docs/changelogs/0.28.0.mdx` | `docs/pages/changelogs/0.28.0.mdx` | `/changelogs/0.28.0` |
| `docs/changelogs/0.29.0.mdx` | `docs/pages/changelogs/0.29.0.mdx` | `/changelogs/0.29.0` |
| `docs/changelogs/0.30.0.mdx` | `docs/pages/changelogs/0.30.0.mdx` | `/changelogs/0.30.0` |
| `docs/changelogs/0.31.0.mdx` | `docs/pages/changelogs/0.31.0.mdx` | `/changelogs/0.31.0` |
| `docs/changelogs/0.31.1.mdx` | `docs/pages/changelogs/0.31.1.mdx` | `/changelogs/0.31.1` |
| `docs/changelogs/0.32.0.mdx` | `docs/pages/changelogs/0.32.0.mdx` | `/changelogs/0.32.0` |
| `docs/changelogs/0.33.0.mdx` | `docs/pages/changelogs/0.33.0.mdx` | `/changelogs/0.33.0` |
| `docs/changelogs/0.34.0.mdx` | `docs/pages/changelogs/0.34.0.mdx` | `/changelogs/0.34.0` |
| `docs/changelogs/0.35.0.mdx` | `docs/pages/changelogs/0.35.0.mdx` | `/changelogs/0.35.0` |
| `docs/changelogs/compatibility-policy.md` | `docs/pages/changelogs/compatibility-policy.md` | `/changelogs/compatibility-policy` |

## Model registry

2 files. retained at its committed path: an installed Smithers 0.x CLI fetches this file from the repository's main branch in its update check.

| Was | Is | Route |
| --- | --- | --- |
| `docs/data/sota-benchmarks.json` | `docs/data/sota-benchmarks.json` | not routed |
| `docs/data/sota-models.json` | `docs/data/sota-models.json` | not routed |

## Deleted, with the reason

Each rule below names assets the ledger deletes. Nothing in the tree matches
them; the rule stays here so a file that comes back is caught.

| Rule | Reason |
| --- | --- |
| `docs/images/monitor/run-detail.png` | docs/images/monitor/{run-detail,runs}.png + docs/images/tui/* (15 files) + docs/images/workflow-ui/* except review.png and implement.png (29 files) + docs/images/0.29.0/xstate-devtools.png + docs/images/state-machine.jpg + docs/images/why/{agent-stack,crash-resume}.svg (50 files) |

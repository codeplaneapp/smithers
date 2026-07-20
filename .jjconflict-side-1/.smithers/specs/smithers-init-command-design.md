# Smithers init command design

This document describes the current curated `smithers init` contract.

## Installed workflow pack

`smithers init` installs exactly six workflows:

- public: `create-workflow`, `create-skill`, `docs-driven-development`
- hidden system: `init`, `post-failure`, `upgrade`

The pack is fixed rather than user-selectable. Re-running init refreshes the same
curated closure while preserving existing files unless `--force` is supplied.
System workflows remain explicitly runnable but are hidden from normal workflow
discovery surfaces.

Each public workflow installs its real dependency closure. In particular,
docs-driven-development includes its portable helpers, Gateway UI, gateway-react
types and hooks, Mermaid support, prompts, and starter spec files. The installed
sources must typecheck and load without assuming a Smithers repository layout,
package manager, agent provider, or model name.

## Workflow authoring

`create-workflow` is the first-run authoring path. A successful run writes the
requested workflow and exactly one companion skill at
`.smithers/skills/<workflow>.md`. The skill must contain parseable YAML
frontmatter whose `name` and `workflow` fields exactly match the workflow id.
Missing, malformed, mismatched, or alternate-path skill output is rejected and
retried within the workflow's bounded verification loop.

`init --template <id>` has the same contract for every template: install the
curated pack and return a starter request for `create-workflow`. It never installs
or claims to install a retired default workflow.

## Archived starter catalog

The 29 former default workflows live under `examples/init-pack/` as copyable
examples. They are not installed by init. Each archived workflow carries a
workflow-specific what/why/run-or-copy header, and the archive retains the full
transitive graph and UI dependency closure needed to load every graph and bundle
every archived UI.

## Verification

The supported contract is enforced with clean-init filename and discovery tests,
real graph loading for all six installed workflows and all archived workflows,
clean-init typechecking, fake-agent no-mock workflow runs, exact positive and
negative companion-skill E2Es, and real Gateway UI bundling. Browser execution is
skipped only when the host has no browser binary.

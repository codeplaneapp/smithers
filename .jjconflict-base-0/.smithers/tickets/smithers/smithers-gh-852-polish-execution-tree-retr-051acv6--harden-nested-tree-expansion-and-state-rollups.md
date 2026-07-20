# Harden nested tree expansion and state rollups

GitHub: https://github.com/smithersai/smithers/issues/949

Parent: smithers/gh-852-polish-execution-tree-retries-and-node-inspection.md

Context: Nested execution trees need readable default expansion while still surfacing hidden failures. Acceptance criteria: expand shallow containers and ancestors of running, waiting, or failed nodes; preserve user collapse overrides across live updates; show failure indicators on collapsed branches; maintain accessible tree semantics; add rendering coverage for nested, failed, and live trees.

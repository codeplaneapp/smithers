# Preserve retry-attempt metadata in the execution tree

GitHub: https://github.com/smithersai/smithers/issues/947

Parent: smithers/gh-852-polish-execution-tree-retries-and-node-inspection.md

Context: Gateway snapshots include per-node attempt numbers, but the gateway client currently preserves only iteration and status. Acceptance criteria: add optional attempt metadata to GatewayRunNode; preserve it through snapshot mapping, flattening, and live collections; display retry/attempt state distinctly from loop iteration; use the correct node identity when loading attempt-scoped output or diffs; add unit tests for mapping and rendering.

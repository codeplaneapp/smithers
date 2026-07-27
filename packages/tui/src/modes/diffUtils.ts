/**
 * The `getNodeDiff` view-model shaping moved to
 * `@smithers-orchestrator/ui-core` (research/tui-parity/01-packages.md
 * phase 2). Re-exported here so the existing relative imports across
 * packages/tui (and its tests) keep working; ui-core is the single source
 * of truth — do not add logic to this file.
 */
export * from "@smithers-orchestrator/ui-core/runs/diffUtils";

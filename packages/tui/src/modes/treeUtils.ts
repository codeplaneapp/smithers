/**
 * The node-tree flatten/selection/scroll-window logic moved to
 * `@smithers-orchestrator/ui-core` (research/tui-parity/01-packages.md:
 * "packages/tui/src/modes/*Utils.ts where they duplicate multi domain
 * logic"). Re-exported here so the existing relative imports across
 * packages/tui (and its tests) keep working; ui-core is the single source
 * of truth — do not add logic to this file.
 */
export * from "@smithers-orchestrator/ui-core/runs/treeUtils";

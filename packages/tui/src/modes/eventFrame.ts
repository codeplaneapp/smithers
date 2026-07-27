/**
 * The gateway event-envelope normalizer moved to
 * `@smithers-orchestrator/ui-core` (research/tui-parity/01-packages.md:
 * "eventFrame.ts is the shared event-envelope normalizer and belongs in
 * ui-core"). Re-exported here so the existing relative imports across
 * packages/tui (and its tests) keep working; ui-core is the single source
 * of truth — do not add logic to this file.
 */
export * from "@smithers-orchestrator/ui-core/runs/eventFrame";

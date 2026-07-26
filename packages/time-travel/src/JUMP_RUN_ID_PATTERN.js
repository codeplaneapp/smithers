// Run-id shape accepted by rewind RPCs: lowercase slug/uuid chars plus the dots
// `smithers up --run-id` lets operators create (e.g. `panel-vbt-1.2.0`), 1-64
// long. A leading dot stays rejected so `.`/`..` never reach a path join.
// Mirrors the server's RUN_ID_PATTERN (gatewayRoutes/RUN_ID_PATTERN.js), which
// this package cannot import without a dependency cycle — keep the two in sync.
// Quoted verbatim in validateJumpRunId's InvalidRunId message.
export const JUMP_RUN_ID_PATTERN = /^[a-z0-9_-][a-z0-9_.-]{0,63}$/;

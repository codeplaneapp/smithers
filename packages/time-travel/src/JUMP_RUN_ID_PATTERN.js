// Run-id shape accepted by rewind RPCs: lowercase slug/uuid chars, 1-64 long.
// Quoted verbatim in validateJumpRunId's InvalidRunId message — keep the two in sync.
export const JUMP_RUN_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;

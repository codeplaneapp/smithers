// Run-id shape accepted by rewind RPCs: operator slugs up to 64 characters,
// plus the deterministic `:child:<node>:<iteration>` suffixes the engine adds.
// Child ids may nest and are bounded separately by validateJumpRunId to the
// database's 256-character run-id limit. A leading dot stays rejected so
// `.`/`..` never reach a path join.
// The first alternative mirrors the server's operator-run pattern. The second
// is specific to time travel because child runs are separately addressable.
export const JUMP_RUN_ID_PATTERN =
  /^(?:[a-z0-9_-][a-z0-9_.-]{0,63}|[a-z0-9_-][a-z0-9_.-]{0,255}(?::child:[a-z0-9_.-]+:[0-9]+)+)$/;

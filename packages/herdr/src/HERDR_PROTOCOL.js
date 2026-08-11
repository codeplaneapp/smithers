/**
 * Herdr socket wire-protocol version this client is written against
 * (herdr 0.8.0). {@link createHerdrClient}'s `ping()` warns when the connected
 * server reports a different protocol; callers may opt into a hard failure via
 * `ping({ requireProtocolMatch: true })`.
 */
export const HERDR_PROTOCOL = 19;

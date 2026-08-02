/**
 * Herdr socket wire-protocol version this client is written against
 * (herdr 0.7.3). {@link createHerdrClient}'s `ping()` warns when the connected
 * server reports a different protocol; callers may opt into a hard failure via
 * `ping({ requireProtocolMatch: true })`.
 */
declare const HERDR_PROTOCOL: 16;

export { HERDR_PROTOCOL };

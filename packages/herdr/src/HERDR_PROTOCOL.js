/**
 * Herdr socket wire-protocol version this client is written against
 * (herdr 0.7.3). {@link createHerdrClient}'s `ping()` warns when the connected
 * server reports a different protocol; it never hard-fails on a mismatch.
 */
export const HERDR_PROTOCOL = 16;

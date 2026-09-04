const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * Ulid-ish id: millisecond timestamp (base32, sortable) + 16 chars of
 * crypto randomness. Good enough for a bug intake; no collision registry.
 */
export function newBugId(now: number = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let rand = "";
  for (const b of bytes) rand += ALPHABET[b % 32];
  return time + rand;
}

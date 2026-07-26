// Pure, dependency-free helpers split out of worker.ts so they're unit-testable
// under plain `bun test` — worker.ts transitively imports `@cloudflare/containers`,
// which resolves the Workers-runtime built-in `cloudflare:workers` module and
// therefore only loads inside an actual Workers runtime (miniflare/wrangler),
// not plain Bun.

/** DST-correct guard: exactly one of the two 11:00/12:00 UTC firings is 7am ET on any given day. */
export function isPrimaryFireHour(etHour: number): boolean {
  return etHour === 7;
}

/** DST-correct guard: exactly one of the two 12:15/13:15 UTC firings is 8:15am ET on any given day. */
export function isWatchdogFireTime(etHour: number, etMinute: number): boolean {
  return etHour === 8 && etMinute === 15;
}

export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const bytesA = new Uint8Array(digestA);
  const bytesB = new Uint8Array(digestB);
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) diff |= bytesA[i]! ^ bytesB[i]!;
  return diff === 0;
}

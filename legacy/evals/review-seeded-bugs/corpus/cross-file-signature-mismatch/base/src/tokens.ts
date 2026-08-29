export function issueToken(userId: string, ttlSeconds: number): string {
  const expiresAt = Date.now() + ttlSeconds * 1000;
  return `${userId}:${expiresAt}`;
}

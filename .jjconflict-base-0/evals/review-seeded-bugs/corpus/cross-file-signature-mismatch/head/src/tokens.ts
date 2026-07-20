export function issueToken(userId: string, expiresAtMs: number): string {
  return `${userId}:${expiresAtMs}`;
}

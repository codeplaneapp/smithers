import { issueToken } from "./tokens";

export function createSession(userId: string): { token: string } {
  const token = issueToken(userId, 3600);
  return { token };
}

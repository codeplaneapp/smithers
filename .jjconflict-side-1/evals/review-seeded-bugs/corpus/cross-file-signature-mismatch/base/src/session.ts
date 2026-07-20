import { issueToken } from "./tokens";

export function createSession(userId: string): { token: string } {
  return { token: issueToken(userId, 3600) };
}

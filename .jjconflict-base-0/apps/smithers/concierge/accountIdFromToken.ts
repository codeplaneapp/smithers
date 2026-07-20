import { decodeJwtPayload } from "./decodeJwtPayload";

/** Pull the ChatGPT account id from a codex access token's auth claim, if present. */
export function accountIdFromToken(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.["https://api.openai.com/auth"];
  if (auth && typeof auth === "object") {
    const id = (auth as Record<string, unknown>).chatgpt_account_id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
}

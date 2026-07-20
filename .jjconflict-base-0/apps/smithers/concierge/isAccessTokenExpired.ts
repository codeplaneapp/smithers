import { decodeJwtPayload } from "./decodeJwtPayload";

/**
 * Treat a codex access token as expired when its `exp` claim is missing or
 * within `skewMs` of now, so we refresh before the upstream would reject it.
 */
export function isAccessTokenExpired(accessToken: string, skewMs = 60_000): boolean {
  const payload = decodeJwtPayload(accessToken);
  const exp = payload && typeof payload.exp === "number" ? payload.exp : 0;
  if (!exp) return true;
  return exp * 1000 - skewMs <= Date.now();
}

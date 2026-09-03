/** Per-launch local-origin capability contract shared by Bun and the browser. */
export const LOCAL_SESSION_META = "smithers-local-session"
export const LOCAL_SESSION_HEADER = "x-smithers-local-session"
export const LOCAL_SESSION_PROTOCOL_PREFIX = "smithers.local."

/** Tokens are 256 random bits encoded as unpadded base64url. */
export const isLocalSessionToken = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value)

export const localSessionProtocol = (token: string): string => `${LOCAL_SESSION_PROTOCOL_PREFIX}${token}`

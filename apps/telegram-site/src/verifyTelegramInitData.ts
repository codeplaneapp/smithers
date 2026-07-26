// Reference Telegram Mini App initData verification for a Cloudflare Worker.
//
// This mirrors `verifyTelegramWebAppInitData` from
// `@smithers-orchestrator/integrations/telegram` — it is inlined here so the
// Worker bundle stays dependency-free and copy-pasteable. It does REAL HMAC
// verification (no mocks): secret = HMAC_SHA256(key="WebAppData", msg=botToken);
// authentic iff hex(HMAC_SHA256(key=secret, msg=dataCheckString)) === hash,
// where dataCheckString is every field except `hash` (the `signature` field
// STAYS IN), as key=value sorted and newline-joined. Uses Web Crypto so it runs
// on workerd. Never trust `initDataUnsafe`; verify this raw string server-side.

export type TelegramInitDataUser = {
  id: number;
  username?: string;
  first_name?: string;
  [key: string]: unknown;
};

export type VerifiedTelegramInitData = {
  user: TelegramInitDataUser | null;
  authDate: number | null;
  queryId: string | null;
};

export type VerifyTelegramInitDataResult =
  | { ok: true; initData: VerifiedTelegramInitData }
  | { ok: false; reason: string };

const encoder = new TextEncoder();

function bytesToHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time equality of two equal-length hex strings. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseJson(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function verifyTelegramInitData(
  initData: string,
  botToken: string,
  options: { maxAgeSeconds?: number; nowMs?: number } = {},
): Promise<VerifyTelegramInitDataResult> {
  if (!botToken) return { ok: false, reason: "missing_bot_token" };
  if (!initData) return { ok: false, reason: "empty" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "missing_hash" };

  const maxAgeSeconds = options.maxAgeSeconds ?? 3600;
  const authDateRaw = params.get("auth_date");
  const authDate = authDateRaw && /^\d+$/.test(authDateRaw) ? Number.parseInt(authDateRaw, 10) : null;
  if (maxAgeSeconds > 0) {
    if (authDate == null) return { ok: false, reason: "missing_auth_date" };
    if (authDate * 1000 + maxAgeSeconds * 1000 < (options.nowMs ?? Date.now())) {
      return { ok: false, reason: "expired" };
    }
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");

  const webAppDataKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const secret = await crypto.subtle.sign("HMAC", webAppDataKey, encoder.encode(botToken));
  const secretKey = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", secretKey, encoder.encode(dataCheckString));
  if (!timingSafeEqualHex(bytesToHex(mac), hash)) {
    return { ok: false, reason: "bad_signature" };
  }

  return {
    ok: true,
    initData: {
      user: parseJson(params.get("user")) as TelegramInitDataUser | null,
      authDate,
      queryId: params.get("query_id"),
    },
  };
}

// @smithers-type-exports-begin
/** @typedef {import("./initData.ts").TelegramInitData} TelegramInitData */
/** @typedef {import("./initData.ts").TelegramInitDataUser} TelegramInitDataUser */
/** @typedef {import("./initData.ts").VerifyTelegramWebAppInitDataOptions} VerifyTelegramWebAppInitDataOptions */
/** @typedef {import("./initData.ts").VerifyTelegramWebAppInitDataSignatureOptions} VerifyTelegramWebAppInitDataSignatureOptions */
// @smithers-type-exports-end

// Telegram Mini App (Web App) initData verification.
//
// initData is the signed query string a Mini App exposes as
// `window.Telegram.WebApp.initData`. Your backend must verify it before
// trusting the user — never trust `initDataUnsafe`.
//
// Two paths, both implemented with Web Crypto (globalThis.crypto.subtle) so the
// same code runs in the Smithers runtime (Node/Bun) AND a Cloudflare Worker:
//   HMAC (you hold the bot token): secret = HMAC_SHA256(key="WebAppData",
//     msg=botToken); authentic iff hex(HMAC_SHA256(key=secret, msg=dcs)) === hash,
//     where dcs is every field except `hash` (the `signature` field STAYS IN),
//     as key=value sorted and newline-joined.
//   Ed25519 (third parties with only the numeric bot id): message is
//     "<botId>:WebAppData\n" + fields except `hash` AND `signature`, verified
//     against Telegram's public key.
// Verified against core.telegram.org/bots/webapps, @telegram-apps/init-data-node,
// and aiogram.

import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

/** Telegram's production Ed25519 public key (hex) for third-party validation. */
export const TELEGRAM_WEBAPP_ED25519_PUBLIC_KEY_PROD =
  "e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d";

/** Telegram's test-datacenter Ed25519 public key (hex). */
export const TELEGRAM_WEBAPP_ED25519_PUBLIC_KEY_TEST =
  "40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec";

const DEFAULT_MAX_AGE_SECONDS = 3600;
const encoder = new TextEncoder();

/**
 * @param {ArrayBuffer | Uint8Array} buffer
 * @returns {string} lowercase hex
 */
function bytesToHex(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let out = "";
  for (let index = 0; index < bytes.length; index += 1) {
    out += bytes[index].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * @param {string} hex
 * @returns {Uint8Array}
 */
function hexToBytes(hex) {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new SmithersError("INVALID_INPUT", "Expected an even-length hex string.");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Decode a base64url string (padding optional) to bytes.
 * @param {string} value
 * @returns {Uint8Array}
 */
function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.length % 4 === 0 ? base64 : base64 + "=".repeat(4 - (base64.length % 4));
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Constant-time equality of two equal-length hex strings. The received hash is
 * attacker-controlled, so this avoids the classic HMAC-verification timing
 * side-channel (the reference JS libs use a plain `===`; we do not).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

/**
 * @param {URLSearchParams} params
 * @param {string} key
 * @returns {Record<string, unknown> | null}
 */
function parseJsonField(params, key) {
  const raw = params.get(key);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Parse a raw Mini App `initData` query string into its fields. Uses
 * `URLSearchParams` (split-then-decode-each-value-once), which is the robust
 * parse — decoding the whole string first would corrupt values containing
 * percent-encoded delimiters inside the JSON `user`/`chat` blobs.
 * @param {string} initData
 * @returns {TelegramInitData}
 */
export function parseTelegramInitData(initData) {
  const raw = typeof initData === "string" ? initData : "";
  const params = new URLSearchParams(raw);
  /** @type {Record<string, string>} */
  const all = {};
  for (const [key, value] of params.entries()) {
    all[key] = value;
  }
  const authDateRaw = params.get("auth_date");
  const authDate = authDateRaw != null && /^\d+$/.test(authDateRaw)
    ? Number.parseInt(authDateRaw, 10)
    : null;
  return {
    raw,
    hash: params.get("hash"),
    signature: params.get("signature"),
    authDate,
    queryId: params.get("query_id"),
    user: /** @type {TelegramInitDataUser | null} */ (parseJsonField(params, "user")),
    receiver: /** @type {TelegramInitDataUser | null} */ (parseJsonField(params, "receiver")),
    chat: parseJsonField(params, "chat"),
    chatType: params.get("chat_type"),
    chatInstance: params.get("chat_instance"),
    startParam: params.get("start_param"),
    params: all,
  };
}

/**
 * Build the data-check-string: every pair except the excluded keys, formatted
 * `key=value` (decoded once), sorted, joined by newline.
 * @param {URLSearchParams} params
 * @param {Set<string>} exclude
 * @returns {string}
 */
function buildDataCheckString(params, exclude) {
  const pairs = [];
  for (const [key, value] of params.entries()) {
    if (exclude.has(key)) {
      continue;
    }
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  return pairs.join("\n");
}

/**
 * @param {number | null} authDate seconds
 * @param {number} maxAgeSeconds
 * @param {number} nowMs
 * @returns {boolean} true when fresh (or the check is disabled)
 */
function isFresh(authDate, maxAgeSeconds, nowMs) {
  if (maxAgeSeconds <= 0) {
    return true;
  }
  if (authDate == null) {
    return false;
  }
  return authDate * 1000 + maxAgeSeconds * 1000 >= nowMs;
}

/**
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {SmithersError}
 */
function invalid(message, details) {
  return new SmithersError("TELEGRAM_INIT_DATA_INVALID", message, details);
}

/**
 * Verify a Mini App's `initData` with the HMAC path (your server holds the bot
 * token). Resolves to the parsed, trusted fields on success; rejects with a
 * `SmithersError` (`TELEGRAM_INIT_DATA_INVALID`) otherwise. The bot token is
 * never included in the error output.
 *
 * @param {string} initData raw `window.Telegram.WebApp.initData` query string
 * @param {string} botToken bot token from @BotFather
 * @param {VerifyTelegramWebAppInitDataOptions} [options]
 * @returns {Promise<TelegramInitData>}
 */
export async function verifyTelegramWebAppInitData(initData, botToken, options = {}) {
  if (!botToken || typeof botToken !== "string") {
    throw new SmithersError("INVALID_INPUT", "verifyTelegramWebAppInitData requires a bot token.");
  }
  if (typeof initData !== "string" || initData.length === 0) {
    throw invalid("initData is empty.");
  }
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) {
    throw invalid("initData is missing the hash field.");
  }
  const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  const parsed = parseTelegramInitData(initData);
  if (!isFresh(parsed.authDate, maxAgeSeconds, options.nowMs ?? Date.now())) {
    throw invalid("initData is expired or missing auth_date.", { authDate: parsed.authDate });
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new SmithersError("UNSUPPORTED", "Web Crypto (crypto.subtle) is not available in this runtime.");
  }
  // secret_key = HMAC_SHA256(key="WebAppData", message=botToken)
  const webAppDataKey = await subtle.importKey("raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await subtle.sign("HMAC", webAppDataKey, encoder.encode(botToken));
  const dataCheckString = buildDataCheckString(params, new Set(["hash"]));
  const secretKey = await subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await subtle.sign("HMAC", secretKey, encoder.encode(dataCheckString));
  if (!timingSafeEqualHex(bytesToHex(mac), hash)) {
    throw invalid("initData HMAC signature does not match.");
  }
  return parsed;
}

/**
 * Verify a Mini App's `initData` with the Ed25519 third-party path (you only
 * need the numeric bot id + Telegram's public key, not the bot token). Resolves
 * to the parsed fields on success; rejects otherwise.
 *
 * @param {string} initData raw initData query string (must include `signature`)
 * @param {number | string} botId numeric bot id (the part before `:` in the token)
 * @param {VerifyTelegramWebAppInitDataSignatureOptions} [options]
 * @returns {Promise<TelegramInitData>}
 */
export async function verifyTelegramWebAppInitDataSignature(initData, botId, options = {}) {
  if (botId == null || String(botId).length === 0) {
    throw new SmithersError("INVALID_INPUT", "verifyTelegramWebAppInitDataSignature requires a numeric bot id.");
  }
  if (typeof initData !== "string" || initData.length === 0) {
    throw invalid("initData is empty.");
  }
  const params = new URLSearchParams(initData);
  const signature = params.get("signature");
  if (!signature) {
    throw invalid("initData is missing the signature field.");
  }
  const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  const parsed = parseTelegramInitData(initData);
  if (!isFresh(parsed.authDate, maxAgeSeconds, options.nowMs ?? Date.now())) {
    throw invalid("initData is expired or missing auth_date.", { authDate: parsed.authDate });
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new SmithersError("UNSUPPORTED", "Web Crypto (crypto.subtle) is not available in this runtime.");
  }
  const publicKeyHex = options.publicKeyHex ?? TELEGRAM_WEBAPP_ED25519_PUBLIC_KEY_PROD;
  const dataCheckString = buildDataCheckString(params, new Set(["hash", "signature"]));
  const message = `${botId}:WebAppData\n${dataCheckString}`;
  let key;
  try {
    key = await subtle.importKey("raw", hexToBytes(publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
  } catch (cause) {
    throw new SmithersError("UNSUPPORTED", "Ed25519 verification is not supported in this runtime.", undefined, { cause });
  }
  const ok = await subtle.verify("Ed25519", key, base64UrlToBytes(signature), encoder.encode(message));
  if (!ok) {
    throw invalid("initData Ed25519 signature does not match.");
  }
  return parsed;
}

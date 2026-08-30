/**
 * Telegram Mini App `initData` verification.
 *
 * `initData` is the signed query string a Mini App exposes as
 * `window.Telegram.WebApp.initData`. A backend must verify it before trusting
 * the user; `initDataUnsafe` is named that for a reason.
 *
 * Two paths, both on Web Crypto so the same code runs under Node, Bun, and a
 * Cloudflare Worker:
 *
 * - **HMAC**, when you hold the bot token. The secret is
 *   `HMAC_SHA256(key="WebAppData", msg=botToken)`, and the data-check string is
 *   every field except `hash`, with the `signature` field staying in, as
 *   `key=value`, sorted, newline-joined.
 * - **Ed25519**, for a third party holding only the numeric bot id. The
 *   message is `<botId>:WebAppData\n` plus the data-check string with both
 *   `hash` and `signature` removed, verified against Telegram's public key.
 *
 * Verified against core.telegram.org/bots/webapps,
 * `@telegram-apps/init-data-node`, and aiogram.
 *
 * @since 1.0.0
 */
import { SmithersError } from "@smthrs/errors/SmithersError"

/**
 * Telegram's production Ed25519 public key, in hex.
 *
 * @category constants
 * @since 1.0.0
 */
export const ED25519_PUBLIC_KEY_PROD = "e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d"

/**
 * Telegram's test-datacenter Ed25519 public key, in hex.
 *
 * @category constants
 * @since 1.0.0
 */
export const ED25519_PUBLIC_KEY_TEST = "40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec"

const DEFAULT_MAX_AGE_SECONDS = 3600
const encoder = new TextEncoder()

/**
 * A Telegram user, as it appears inside `initData`.
 *
 * @category models
 * @since 1.0.0
 */
export interface InitDataUser {
  readonly id: number
  readonly is_bot?: boolean | undefined
  readonly first_name?: string | undefined
  readonly last_name?: string | undefined
  readonly username?: string | undefined
  readonly language_code?: string | undefined
  readonly is_premium?: boolean | undefined
  readonly photo_url?: string | undefined
  readonly [key: string]: unknown
}

/**
 * The parsed contents of an `initData` query string.
 *
 * @category models
 * @since 1.0.0
 */
export interface InitData {
  /** The exact string that was verified. */
  readonly raw: string
  readonly hash: string | null
  readonly signature: string | null
  /** `auth_date` in seconds, or `null` when absent or non-numeric. */
  readonly authDate: number | null
  /** Present only for an inline-keyboard or menu-button launch. */
  readonly queryId: string | null
  readonly user: InitDataUser | null
  readonly receiver: InitDataUser | null
  readonly chat: Record<string, unknown> | null
  readonly chatType: string | null
  readonly chatInstance: string | null
  /** From a `?startapp=` deep link. */
  readonly startParam: string | null
  /** Every decoded pair, for fields not surfaced above. */
  readonly params: Readonly<Record<string, string>>
}

/**
 * What the verifiers allow.
 *
 * @category models
 * @since 1.0.0
 */
export interface VerifyOptions {
  /** Reject `initData` older than this. `0` disables the check. Defaults to 3600. */
  readonly maxAgeSeconds?: number | undefined
  /** Overrides "now", in epoch milliseconds. */
  readonly nowMs?: number | undefined
}

/**
 * What {@link verifySignature} allows.
 *
 * @category models
 * @since 1.0.0
 */
export interface VerifySignatureOptions extends VerifyOptions {
  /** The Ed25519 public key, in hex. Defaults to the production key. */
  readonly publicKeyHex?: string | undefined
}

const bytesToHex = (buffer: ArrayBuffer | Uint8Array): string => {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let out = ""
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0")
  return out
}

const hexToBytes = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new SmithersError("INVALID_INPUT", "Expected an even-length hex string.")
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

const base64UrlToBytes = (value: string): Uint8Array => {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/")
  const padded = base64.length % 4 === 0 ? base64 : base64 + "=".repeat(4 - (base64.length % 4))
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * Constant-time equality of two hex strings.
 *
 * The received hash is attacker-controlled, so a `===` here would be the
 * classic HMAC-verification timing side channel. The reference JavaScript
 * libraries use `===`; this does not.
 */
const timingSafeEqualHex = (left: string, right: string): boolean => {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

const parseJsonField = (params: URLSearchParams, key: string): Record<string, unknown> | null => {
  const raw = params.get(key)
  if (raw === null || raw.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * Parses `initData` into its fields.
 *
 * Uses `URLSearchParams`, which splits before decoding each value once.
 * Decoding the whole string first would corrupt any value containing a
 * percent-encoded delimiter, which the JSON `user` and `chat` blobs routinely
 * do.
 *
 * @category constructors
 * @since 1.0.0
 */
export const parse = (initData: string): InitData => {
  const raw = typeof initData === "string" ? initData : ""
  const params = new URLSearchParams(raw)
  const all: Record<string, string> = {}
  for (const [key, value] of params.entries()) all[key] = value
  const authDateRaw = params.get("auth_date")
  const authDate = authDateRaw !== null && /^\d+$/.test(authDateRaw) ? Number.parseInt(authDateRaw, 10) : null
  return {
    raw,
    hash: params.get("hash"),
    signature: params.get("signature"),
    authDate,
    queryId: params.get("query_id"),
    user: parseJsonField(params, "user") as InitDataUser | null,
    receiver: parseJsonField(params, "receiver") as InitDataUser | null,
    chat: parseJsonField(params, "chat"),
    chatType: params.get("chat_type"),
    chatInstance: params.get("chat_instance"),
    startParam: params.get("start_param"),
    params: all
  }
}

/** Every pair except the excluded keys, `key=value`, sorted, newline-joined. */
const dataCheckString = (params: URLSearchParams, exclude: ReadonlySet<string>): string => {
  const pairs: Array<string> = []
  for (const [key, value] of params.entries()) {
    if (!exclude.has(key)) pairs.push(`${key}=${value}`)
  }
  pairs.sort()
  return pairs.join("\n")
}

const isFresh = (authDate: number | null, maxAgeSeconds: number, nowMs: number): boolean => {
  if (maxAgeSeconds <= 0) return true
  if (authDate === null) return false
  return authDate * 1000 + maxAgeSeconds * 1000 >= nowMs
}

const invalid = (message: string, details?: Record<string, unknown>): SmithersError =>
  new SmithersError("TELEGRAM_INIT_DATA_INVALID", message, details)

const subtleCrypto = (): SubtleCrypto => {
  const subtle = globalThis.crypto?.subtle
  if (subtle === undefined) {
    throw new SmithersError("UNSUPPORTED", "Web Crypto (crypto.subtle) is not available in this runtime.")
  }
  return subtle
}

/**
 * Verifies `initData` with the bot token.
 *
 * Resolves with the parsed fields, or rejects with `TELEGRAM_INIT_DATA_INVALID`.
 * The bot token never appears in the error output.
 *
 * @category verification
 * @since 1.0.0
 */
export const verifyWithBotToken = async (
  initData: string,
  botToken: string,
  options: VerifyOptions = {}
): Promise<InitData> => {
  if (typeof botToken !== "string" || botToken.length === 0) {
    throw new SmithersError("INVALID_INPUT", "verifyWithBotToken requires a bot token.")
  }
  if (typeof initData !== "string" || initData.length === 0) throw invalid("initData is empty.")
  const params = new URLSearchParams(initData)
  const hash = params.get("hash")
  if (hash === null || hash.length === 0) throw invalid("initData is missing the hash field.")
  const parsed = parse(initData)
  if (!isFresh(parsed.authDate, options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS, options.nowMs ?? Date.now())) {
    throw invalid("initData is expired or missing auth_date.", { authDate: parsed.authDate })
  }
  const subtle = subtleCrypto()
  const webAppDataKey = await subtle.importKey(
    "raw",
    encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const secret = await subtle.sign("HMAC", webAppDataKey, encoder.encode(botToken))
  const secretKey = await subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const mac = await subtle.sign("HMAC", secretKey, encoder.encode(dataCheckString(params, new Set(["hash"]))))
  if (!timingSafeEqualHex(bytesToHex(mac), hash)) throw invalid("initData HMAC signature does not match.")
  return parsed
}

/**
 * Verifies `initData` with Telegram's Ed25519 key and the numeric bot id.
 *
 * For a third party that must authenticate a Mini App user without holding the
 * bot token.
 *
 * @category verification
 * @since 1.0.0
 */
export const verifySignature = async (
  initData: string,
  botId: number | string,
  options: VerifySignatureOptions = {}
): Promise<InitData> => {
  if (botId == null || String(botId).length === 0) {
    throw new SmithersError("INVALID_INPUT", "verifySignature requires a numeric bot id.")
  }
  if (typeof initData !== "string" || initData.length === 0) throw invalid("initData is empty.")
  const params = new URLSearchParams(initData)
  const signature = params.get("signature")
  if (signature === null || signature.length === 0) throw invalid("initData is missing the signature field.")
  const parsed = parse(initData)
  if (!isFresh(parsed.authDate, options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS, options.nowMs ?? Date.now())) {
    throw invalid("initData is expired or missing auth_date.", { authDate: parsed.authDate })
  }
  const subtle = subtleCrypto()
  const message = `${botId}:WebAppData\n${dataCheckString(params, new Set(["hash", "signature"]))}`
  // The signature is attacker-controlled: a malformed base64url value must
  // reject as invalid init data, not escape as a raw DOMException.
  let signatureBytes: Uint8Array
  try {
    signatureBytes = base64UrlToBytes(signature)
  } catch {
    throw invalid("initData signature is not valid base64url.")
  }
  let key: CryptoKey
  try {
    key = await subtle.importKey(
      "raw",
      hexToBytes(options.publicKeyHex ?? ED25519_PUBLIC_KEY_PROD) as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"]
    )
  } catch (cause) {
    throw new SmithersError("UNSUPPORTED", "Ed25519 verification is not supported in this runtime.", undefined, {
      cause
    })
  }
  const ok = await subtle.verify("Ed25519", key, signatureBytes as BufferSource, encoder.encode(message))
  if (!ok) throw invalid("initData Ed25519 signature does not match.")
  return parsed
}

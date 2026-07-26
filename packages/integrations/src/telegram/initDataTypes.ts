// Types for the Telegram Mini App (Web App) initData verification helpers.
// Algorithm verified against the official docs (core.telegram.org/bots/webapps),
// @telegram-apps/init-data-node, and aiogram.

/** A Telegram user as it appears inside initData's `user`/`receiver` JSON. */
export type TelegramInitDataUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
  [key: string]: unknown;
};

/** The parsed contents of a Mini App `initData` query string. */
export type TelegramInitData = {
  /** The exact raw query string that was verified. */
  raw: string;
  /** HMAC hash field (present on the standard path). */
  hash: string | null;
  /** Ed25519 signature field (present on newer clients / third-party path). */
  signature: string | null;
  /** `auth_date` as a Unix timestamp in seconds, or null when absent/invalid. */
  authDate: number | null;
  /** `query_id` (present only for inline-keyboard / menu-button launches). */
  queryId: string | null;
  /** Parsed `user` object, or null when absent/unparseable. */
  user: TelegramInitDataUser | null;
  /** Parsed `receiver` object, or null. */
  receiver: TelegramInitDataUser | null;
  /** Parsed `chat` object, or null. */
  chat: Record<string, unknown> | null;
  /** `chat_type` (private/group/supergroup/channel), or null. */
  chatType: string | null;
  /** `chat_instance`, or null. */
  chatInstance: string | null;
  /** `start_param` from a `?startapp=` deep link, or null. */
  startParam: string | null;
  /** Every decoded key/value pair, for fields not surfaced above. */
  params: Record<string, string>;
};

export type VerifyTelegramWebAppInitDataOptions = {
  /**
   * Reject `initData` whose `auth_date` is older than this many seconds.
   * `0` disables the freshness check. @default 3600 (one hour)
   */
  maxAgeSeconds?: number;
  /** Override "now" (epoch ms) for deterministic tests. */
  nowMs?: number;
};

export type VerifyTelegramWebAppInitDataSignatureOptions = VerifyTelegramWebAppInitDataOptions & {
  /**
   * Ed25519 public key (hex) to verify against. Defaults to Telegram's
   * production key. Pass the test key for the test datacenter.
   */
  publicKeyHex?: string;
};

// @smithers-type-exports-begin
/** @typedef {import("./approvalTypes.ts").TelegramApprovalChoice} TelegramApprovalChoice */
/** @typedef {import("./approvalTypes.ts").TelegramApprovalOption} TelegramApprovalOption */
/** @typedef {import("./approvalTypes.ts").TelegramApprovalMode} TelegramApprovalMode */
/** @typedef {import("./approvalTypes.ts").TelegramApprovalKeyboardSpec} TelegramApprovalKeyboardSpec */
/** @typedef {import("./approvalTypes.ts").TelegramApprovalDecision} TelegramApprovalDecision */
/** @typedef {import("./approvalTypes.ts").TelegramApprovalSelection} TelegramApprovalSelection */
/** @typedef {import("./TelegramClientTypes.ts").TelegramInlineKeyboard} TelegramInlineKeyboard */
/** @typedef {import("./TelegramClientTypes.ts").TelegramInlineKeyboardButton} TelegramInlineKeyboardButton */
// @smithers-type-exports-end

// Inline-keyboard approval building blocks: the callback_data codec, keyboard
// builders, decision-shape schemas, and the press → decision mapping used by
// the `TelegramApproval` component. callback_data is capped at 64 BYTES by
// Telegram, so choices are encoded compactly and never carry trust-sensitive
// state (any chat member can press a button — re-authorize by user id where it
// matters).

import { z } from "zod";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

/** Namespace prefix for approval callback_data (Smithers APproval). */
const CALLBACK_PREFIX = "sap";
/** Telegram's hard limit on callback_data. */
const CALLBACK_DATA_MAX_BYTES = 64;

/** Decision schema for `mode: "approve"` (mirrors the core approvalDecisionSchema). */
export const telegramApprovalDecisionSchema = z.object({
  approved: z.boolean(),
  note: z.string().nullable().optional(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().datetime().nullable(),
});

/** Decision schema for `mode: "select"` (mirrors the core approvalSelectionSchema). */
export const telegramApprovalSelectionSchema = z.object({
  selected: z.string(),
  notes: z.string().nullable(),
});

/**
 * @param {string} value
 * @returns {number} UTF-8 byte length
 */
function byteLength(value) {
  return new TextEncoder().encode(value).length;
}

/**
 * A short, deterministic, colon-free token that disambiguates one approval's
 * buttons from any other keyboard in the same chat. Derived from the node id
 * (djb2 → base36); NOT security-sensitive, just a namespace so a stale/foreign
 * press on a different prompt cannot resolve this approval.
 * @param {string} id
 * @returns {string}
 */
export function approvalToken(id) {
  const source = String(id ?? "");
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) {
    hash = (((hash << 5) + hash) ^ source.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Encode a choice as callback_data (`sap:<token>:a`, `sap:<token>:d`,
 * `sap:<token>:s:<key>`). The token namespaces the press to one approval.
 * @param {TelegramApprovalChoice} choice
 * @param {string} token
 * @returns {string}
 */
export function telegramApprovalCallbackData(choice, token) {
  const tok = token ?? "";
  if (tok.includes(":")) {
    throw new SmithersError("INVALID_INPUT", "Approval token must not contain a colon.");
  }
  let data;
  if (choice.kind === "approve") {
    data = `${CALLBACK_PREFIX}:${tok}:a`;
  } else if (choice.kind === "reject") {
    data = `${CALLBACK_PREFIX}:${tok}:d`;
  } else if (choice.kind === "select") {
    if (!choice.key || choice.key.includes(":")) {
      throw new SmithersError("INVALID_INPUT", `Approval option key must be non-empty and contain no ":": ${JSON.stringify(choice.key)}`);
    }
    data = `${CALLBACK_PREFIX}:${tok}:s:${choice.key}`;
  } else {
    throw new SmithersError("INVALID_INPUT", "Unknown approval choice.");
  }
  if (byteLength(data) > CALLBACK_DATA_MAX_BYTES) {
    throw new SmithersError("INVALID_INPUT", `Approval callback_data exceeds Telegram's ${CALLBACK_DATA_MAX_BYTES}-byte limit (option key too long): ${data}`);
  }
  return data;
}

/**
 * Decode approval callback_data into `{ token, ...choice }`. Returns null for
 * anything that is not ours (a stray press from an unrelated keyboard).
 * @param {string | undefined | null} data
 * @returns {(TelegramApprovalChoice & { token: string }) | null}
 */
export function parseTelegramApprovalCallbackData(data) {
  if (typeof data !== "string") {
    return null;
  }
  const parts = data.split(":");
  if (parts[0] !== CALLBACK_PREFIX || parts.length < 3) {
    return null;
  }
  const token = parts[1];
  const kindCode = parts[2];
  if (kindCode === "a") {
    return { token, kind: "approve" };
  }
  if (kindCode === "d") {
    return { token, kind: "reject" };
  }
  if (kindCode === "s" && parts.length >= 4) {
    const key = parts.slice(3).join(":");
    return key ? { token, kind: "select", key } : null;
  }
  return null;
}

/**
 * True when a delivered callback query is a press on THIS approval's own
 * buttons (matching token), not a stale/foreign press in the same chat.
 * @param {{ data?: string }} callbackQuery
 * @param {TelegramApprovalKeyboardSpec} spec
 * @returns {boolean}
 */
export function isOwnApprovalPress(callbackQuery, spec) {
  const choice = parseTelegramApprovalCallbackData(callbackQuery?.data);
  return Boolean(choice) && choice?.token === (spec.token ?? "");
}

/**
 * Build a Mini App (`web_app`) inline-keyboard button. `url` must be HTTPS.
 * @param {string} text
 * @param {string} url
 * @returns {TelegramInlineKeyboardButton}
 */
export function webAppButton(text, url) {
  if (!url || !/^https:\/\//i.test(url)) {
    throw new SmithersError("INVALID_INPUT", "Telegram web_app buttons require an https:// url.");
  }
  return { text, web_app: { url } };
}

/**
 * Build the inline keyboard for an approval prompt.
 * @param {TelegramApprovalKeyboardSpec} spec
 * @returns {TelegramInlineKeyboard}
 */
export function approvalInlineKeyboard(spec) {
  const token = spec.token ?? "";
  /** @type {TelegramInlineKeyboard} */
  const rows = [];
  if (spec.mode === "select") {
    const options = spec.options ?? [];
    if (options.length === 0) {
      throw new SmithersError("INVALID_INPUT", 'TelegramApproval mode "select" requires at least one option.');
    }
    for (const option of options) {
      rows.push([{ text: option.label, callback_data: telegramApprovalCallbackData({ kind: "select", key: option.key }, token) }]);
    }
  } else {
    rows.push([
      { text: spec.approveText ?? "✅ Approve", callback_data: telegramApprovalCallbackData({ kind: "approve" }, token) },
      { text: spec.rejectText ?? "🚫 Reject", callback_data: telegramApprovalCallbackData({ kind: "reject" }, token) },
    ]);
  }
  if (spec.miniAppUrl) {
    rows.push([webAppButton(spec.miniAppText ?? "🔍 Open review", spec.miniAppUrl)]);
  }
  return rows;
}

/**
 * Who pressed the button, as a stable string (`@username` or the numeric id).
 * @param {{ from?: { id?: number | string; username?: string } }} callbackQuery
 * @returns {string | null}
 */
export function telegramApproverLabel(callbackQuery) {
  const from = callbackQuery?.from;
  if (!from) {
    return null;
  }
  if (typeof from.username === "string" && from.username) {
    return `@${from.username}`;
  }
  if (from.id != null) {
    return String(from.id);
  }
  return null;
}

/**
 * @param {{ message?: { date?: number } }} callbackQuery
 * @returns {string | null} ISO-8601 decided-at, from the message date if present
 */
function decidedAtFromCallback(callbackQuery) {
  const date = callbackQuery?.message?.date;
  return typeof date === "number" ? new Date(date * 1000).toISOString() : null;
}

/**
 * Map a delivered callback query to an approval decision. Deterministic from
 * the persisted payload. A press that is not this approval's own (wrong or
 * missing token) or is otherwise unrecognized fails safe: a non-approval
 * (`approved: false`) in approve mode, or an empty selection in select mode. A
 * stale/foreign press can therefore never produce a false approval.
 * @param {{ data?: string; from?: object; message?: { date?: number } }} callbackQuery
 * @param {TelegramApprovalKeyboardSpec} spec
 * @returns {TelegramApprovalDecision | TelegramApprovalSelection}
 */
export function telegramApprovalDecision(callbackQuery, spec) {
  const choice = parseTelegramApprovalCallbackData(callbackQuery?.data);
  const own = Boolean(choice) && choice?.token === (spec.token ?? "");
  const decidedBy = telegramApproverLabel(callbackQuery);
  if (spec.mode === "select") {
    // Only accept a key THIS approval offered (matching token + a known key);
    // a stale/foreign sap:s:<key> press resolves to no selection.
    const offered = new Set((spec.options ?? []).map((option) => option.key));
    const selected = own && choice?.kind === "select" && offered.has(choice.key) ? choice.key : "";
    return telegramApprovalSelectionSchema.parse({ selected, notes: null });
  }
  return telegramApprovalDecisionSchema.parse({
    approved: own && choice?.kind === "approve",
    note: own ? null : "press did not match this approval's prompt",
    decidedBy,
    decidedAt: decidedAtFromCallback(callbackQuery),
  });
}

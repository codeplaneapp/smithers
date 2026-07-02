// @smithers-type-exports-begin
/** @typedef {import("./approval.ts").TelegramApprovalChoice} TelegramApprovalChoice */
/** @typedef {import("./approval.ts").TelegramApprovalOption} TelegramApprovalOption */
/** @typedef {import("./approval.ts").TelegramApprovalMode} TelegramApprovalMode */
/** @typedef {import("./approval.ts").TelegramApprovalKeyboardSpec} TelegramApprovalKeyboardSpec */
/** @typedef {import("./approval.ts").TelegramApprovalDecision} TelegramApprovalDecision */
/** @typedef {import("./approval.ts").TelegramApprovalSelection} TelegramApprovalSelection */
/** @typedef {import("./TelegramClient.ts").TelegramInlineKeyboard} TelegramInlineKeyboard */
/** @typedef {import("./TelegramClient.ts").TelegramInlineKeyboardButton} TelegramInlineKeyboardButton */
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
  note: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
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
 * Encode a choice as callback_data (`sap:a`, `sap:d`, `sap:s:<key>`).
 * @param {TelegramApprovalChoice} choice
 * @returns {string}
 */
export function telegramApprovalCallbackData(choice) {
  let data;
  if (choice.kind === "approve") {
    data = `${CALLBACK_PREFIX}:a`;
  } else if (choice.kind === "reject") {
    data = `${CALLBACK_PREFIX}:d`;
  } else if (choice.kind === "select") {
    if (!choice.key || choice.key.includes(":")) {
      throw new SmithersError("INVALID_INPUT", `Approval option key must be non-empty and contain no ":": ${JSON.stringify(choice.key)}`);
    }
    data = `${CALLBACK_PREFIX}:s:${choice.key}`;
  } else {
    throw new SmithersError("INVALID_INPUT", "Unknown approval choice.");
  }
  if (byteLength(data) > CALLBACK_DATA_MAX_BYTES) {
    throw new SmithersError("INVALID_INPUT", `Approval callback_data exceeds Telegram's ${CALLBACK_DATA_MAX_BYTES}-byte limit (option key too long): ${data}`);
  }
  return data;
}

/**
 * Decode approval callback_data. Returns null for anything that is not ours
 * (a stray press from an unrelated keyboard).
 * @param {string | undefined | null} data
 * @returns {TelegramApprovalChoice | null}
 */
export function parseTelegramApprovalCallbackData(data) {
  if (typeof data !== "string") {
    return null;
  }
  const parts = data.split(":");
  if (parts[0] !== CALLBACK_PREFIX) {
    return null;
  }
  if (parts[1] === "a") {
    return { kind: "approve" };
  }
  if (parts[1] === "d") {
    return { kind: "reject" };
  }
  if (parts[1] === "s" && parts.length >= 3) {
    const key = parts.slice(2).join(":");
    return key ? { kind: "select", key } : null;
  }
  return null;
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
  /** @type {TelegramInlineKeyboard} */
  const rows = [];
  if (spec.mode === "select") {
    const options = spec.options ?? [];
    if (options.length === 0) {
      throw new SmithersError("INVALID_INPUT", 'TelegramApproval mode "select" requires at least one option.');
    }
    for (const option of options) {
      rows.push([{ text: option.label, callback_data: telegramApprovalCallbackData({ kind: "select", key: option.key }) }]);
    }
  } else {
    rows.push([
      { text: spec.approveText ?? "✅ Approve", callback_data: telegramApprovalCallbackData({ kind: "approve" }) },
      { text: spec.rejectText ?? "🚫 Reject", callback_data: telegramApprovalCallbackData({ kind: "reject" }) },
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
 * the persisted payload. An unrecognized/stray press resolves to a safe
 * non-approval (`approved: false`) in approve mode, or an empty selection in
 * select mode.
 * @param {{ data?: string; from?: object; message?: { date?: number } }} callbackQuery
 * @param {TelegramApprovalKeyboardSpec} spec
 * @returns {TelegramApprovalDecision | TelegramApprovalSelection}
 */
export function telegramApprovalDecision(callbackQuery, spec) {
  const choice = parseTelegramApprovalCallbackData(callbackQuery?.data);
  const decidedBy = telegramApproverLabel(callbackQuery);
  if (spec.mode === "select") {
    const selected = choice?.kind === "select" ? choice.key : "";
    return telegramApprovalSelectionSchema.parse({ selected, notes: null });
  }
  return telegramApprovalDecisionSchema.parse({
    approved: choice?.kind === "approve",
    note: choice ? null : "unrecognized response",
    decidedBy,
    decidedAt: decidedAtFromCallback(callbackQuery),
  });
}

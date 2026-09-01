/**
 * Inline-keyboard approvals.
 *
 * Telegram caps `callback_data` at 64 **bytes**, so a press carries a compact
 * code and nothing else. It also carries no trust: any member of the chat can
 * press a button, so `callback_data` never holds trust-sensitive state and a
 * caller that cares re-authorizes on the presser's user id.
 *
 * The per-approval {@link token} is what keeps one prompt's buttons from
 * resolving another's. A press whose token does not match this approval fails
 * safe: a non-approval in `approve` mode, an empty selection in `select` mode.
 * A prompt built with no token, or an empty one, matches nothing at all, so
 * two tokenless prompts cannot resolve each other.
 *
 * The namespace is a 32-bit hash, not a secret. Two approval ids can collide,
 * and `callback_data` carries no trust in any case: a caller that needs a
 * decision to be authorized re-checks the presser's user id.
 *
 * @since 1.0.0
 */
import { SmithersError } from "@smthrs/errors/SmithersError"
import type { InlineKeyboard, InlineKeyboardButton } from "./TelegramClient.ts"

/** Namespace prefix for approval callback data: Smithers APproval. */
const PREFIX = "sap"

/**
 * Telegram's hard limit on `callback_data`, in bytes.
 *
 * @category constants
 * @since 1.0.0
 */
export const CALLBACK_DATA_MAX_BYTES = 64

/**
 * What an approver can choose.
 *
 * @category models
 * @since 1.0.0
 */
export type Choice = { readonly kind: "approve" } | { readonly kind: "reject" } | {
  readonly kind: "select"
  readonly key: string
}

/**
 * One option offered in `select` mode.
 *
 * @category models
 * @since 1.0.0
 */
export interface Option {
  /** The value echoed back as the decision. Short: callback data is 64 bytes. */
  readonly key: string
  readonly label: string
}

/**
 * How to build the keyboard and read the press.
 *
 * @category models
 * @since 1.0.0
 */
export interface KeyboardSpec {
  readonly mode: "approve" | "select"
  /**
   * Namespaces this approval's buttons. See {@link token}. A spec without one
   * still builds a keyboard, but no press ever matches it, so a prompt that
   * needs to be answerable must carry a token.
   */
  readonly token?: string | undefined
  /** Required and non-empty in `select` mode. */
  readonly options?: ReadonlyArray<Option> | undefined
  readonly approveText?: string | undefined
  readonly rejectText?: string | undefined
  /** Adds a Mini App button opening this HTTPS URL. */
  readonly miniAppUrl?: string | undefined
  readonly miniAppText?: string | undefined
}

/**
 * The decision an `approve`-mode press produces.
 *
 * @category models
 * @since 1.0.0
 */
export interface Decision {
  readonly approved: boolean
  readonly note: string | null
  readonly decidedBy: string | null
  readonly decidedAt: string
}

/**
 * The decision a `select`-mode press produces.
 *
 * @category models
 * @since 1.0.0
 */
export interface Selection {
  readonly selected: string
  readonly notes: string | null
}

const byteLength = (value: string): number => new TextEncoder().encode(value).length

/**
 * A short, colon-free token derived from an id.
 *
 * Not security-sensitive. It is a namespace, so that a press on a different
 * prompt in the same chat is unlikely to resolve this approval. The hash is 32
 * bits wide, so two ids can collide; the guarantee is a namespace, not a
 * capability.
 *
 * @category constructors
 * @since 1.0.0
 */
export const token = (id: string): string => {
  const source = String(id ?? "")
  let hash = 5381
  for (let index = 0; index < source.length; index += 1) {
    hash = (((hash << 5) + hash) ^ source.charCodeAt(index)) >>> 0
  }
  return hash.toString(36)
}

/**
 * Encodes a choice as `callback_data`: `sap:<token>:a`, `sap:<token>:d`, or
 * `sap:<token>:s:<key>`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const callbackData = (choice: Choice, approvalToken: string): string => {
  const value = approvalToken ?? ""
  if (value.includes(":")) throw new SmithersError("INVALID_INPUT", "Approval token must not contain a colon.")
  let data: string
  if (choice.kind === "approve") data = `${PREFIX}:${value}:a`
  else if (choice.kind === "reject") data = `${PREFIX}:${value}:d`
  else {
    if (choice.key.length === 0 || choice.key.includes(":")) {
      throw new SmithersError(
        "INVALID_INPUT",
        `Approval option key must be non-empty and contain no ":": ${JSON.stringify(choice.key)}`
      )
    }
    data = `${PREFIX}:${value}:s:${choice.key}`
  }
  if (byteLength(data) > CALLBACK_DATA_MAX_BYTES) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Approval callback_data exceeds Telegram's ${CALLBACK_DATA_MAX_BYTES}-byte limit (option key too long): ${data}`
    )
  }
  return data
}

/**
 * Decodes `callback_data`, or `null` when the press is not one of ours.
 *
 * @category getters
 * @since 1.0.0
 */
export const parseCallbackData = (data: string | undefined | null): (Choice & { readonly token: string }) | null => {
  if (typeof data !== "string") return null
  const parts = data.split(":")
  if (parts[0] !== PREFIX || parts.length < 3) return null
  const value = parts[1] as string
  const kind = parts[2]
  // The grammar is exactly what `callbackData` emits. `sap:<tok>:a:<extra>` is
  // data this encoder cannot produce, so reading it as an approval would
  // accept a press nothing here built.
  if (kind === "a" && parts.length === 3) return { token: value, kind: "approve" }
  if (kind === "d" && parts.length === 3) return { token: value, kind: "reject" }
  // Exactly four parts: `callbackData` refuses every select key containing a
  // colon, so data with a fifth part is data this encoder cannot produce.
  if (kind === "s" && parts.length === 4) {
    const key = parts[3] as string
    return key.length === 0 ? null : { token: value, kind: "select", key }
  }
  return null
}

/**
 * Whether the press belongs to this approval.
 *
 * An absent or empty `spec.token` matches nothing. Falling back to the empty
 * string would give every tokenless prompt the same namespace, so any
 * tokenless press would resolve any tokenless approval, which is the opposite
 * of what the token is for.
 */
const matchesSpec = <A extends { readonly token: string }>(choice: A | null, spec: KeyboardSpec): choice is A =>
  choice !== null && typeof spec.token === "string" && spec.token.length > 0 && choice.token === spec.token

/**
 * Whether a delivered callback query is a press on this approval's buttons.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isOwnPress = (callbackQuery: { readonly data?: string | undefined }, spec: KeyboardSpec): boolean =>
  matchesSpec(parseCallbackData(callbackQuery?.data), spec)

/**
 * A Mini App button. The URL must be HTTPS, which is Telegram's own rule.
 *
 * @category constructors
 * @since 1.0.0
 */
export const webAppButton = (text: string, url: string): InlineKeyboardButton => {
  if (url.length === 0 || !/^https:\/\//i.test(url)) {
    throw new SmithersError("INVALID_INPUT", "Telegram web_app buttons require an https:// url.")
  }
  return { text, web_app: { url } }
}

/**
 * Builds the keyboard for an approval prompt.
 *
 * @category constructors
 * @since 1.0.0
 */
export const keyboard = (spec: KeyboardSpec): InlineKeyboard => {
  const value = spec.token ?? ""
  const rows: Array<ReadonlyArray<InlineKeyboardButton>> = []
  if (spec.mode === "select") {
    const options = spec.options ?? []
    if (options.length === 0) {
      throw new SmithersError("INVALID_INPUT", "Telegram approval mode \"select\" requires at least one option.")
    }
    for (const option of options) {
      rows.push([{ text: option.label, callback_data: callbackData({ kind: "select", key: option.key }, value) }])
    }
  } else {
    rows.push([
      { text: spec.approveText ?? "Approve", callback_data: callbackData({ kind: "approve" }, value) },
      { text: spec.rejectText ?? "Reject", callback_data: callbackData({ kind: "reject" }, value) }
    ])
  }
  if (spec.miniAppUrl !== undefined) {
    rows.push([webAppButton(spec.miniAppText ?? "Open review", spec.miniAppUrl)])
  }
  return rows
}

/**
 * Who pressed the button, as `@username` or the numeric id.
 *
 * @category getters
 * @since 1.0.0
 */
export const approverLabel = (
  callbackQuery: {
    readonly from?: { readonly id?: number | string | undefined; readonly username?: string | undefined } | undefined
  }
): string | null => {
  const from = callbackQuery?.from
  if (from === undefined) return null
  if (typeof from.username === "string" && from.username.length > 0) return `@${from.username}`
  if (from.id != null) return String(from.id)
  return null
}

/**
 * Maps a delivered callback query to a decision.
 *
 * A press that is not this approval's own, or that is otherwise unrecognized,
 * fails safe. `decidedAt` is the resolution wall clock: Telegram does not
 * report when a button was pressed, and `message.date` is when the prompt was
 * sent, which can be zero for an inaccessible message.
 *
 * @category constructors
 * @since 1.0.0
 */
export const decision = (
  callbackQuery: {
    readonly data?: string | undefined
    readonly from?: { readonly id?: number | string | undefined; readonly username?: string | undefined } | undefined
  },
  spec: KeyboardSpec,
  nowMs: number = Date.now()
): Decision | Selection => {
  const choice = parseCallbackData(callbackQuery?.data)
  const own = matchesSpec(choice, spec)
  if (spec.mode === "select") {
    // Accept only a key this approval offered. A stale `sap:s:<key>` press
    // resolves to no selection rather than to somebody else's option.
    const offered = new Set((spec.options ?? []).map((option) => option.key))
    const selected = own && choice.kind === "select" && offered.has(choice.key) ? choice.key : ""
    return { selected, notes: null }
  }
  return {
    approved: own && choice.kind === "approve",
    note: own ? null : "press did not match this approval's prompt",
    decidedBy: approverLabel(callbackQuery),
    decidedAt: new Date(nowMs).toISOString()
  }
}

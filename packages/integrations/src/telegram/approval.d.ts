import { TelegramInlineKeyboard as TelegramInlineKeyboard$1, TelegramInlineKeyboardButton as TelegramInlineKeyboardButton$1 } from './TelegramClientTypes.js';
import { TelegramApprovalChoice as TelegramApprovalChoice$1, TelegramApprovalDecision as TelegramApprovalDecision$1, TelegramApprovalKeyboardSpec as TelegramApprovalKeyboardSpec$1, TelegramApprovalMode as TelegramApprovalMode$1, TelegramApprovalOption as TelegramApprovalOption$1, TelegramApprovalSelection as TelegramApprovalSelection$1 } from './approvalTypes.js';
import { z } from 'zod';
import 'effect';
import '@smthrs/errors/SmithersError';

/**
 * A short, deterministic, colon-free token that disambiguates one approval's
 * buttons from any other keyboard in the same chat. Derived from the node id
 * (djb2 → base36); NOT security-sensitive, just a namespace so a stale/foreign
 * press on a different prompt cannot resolve this approval.
 * @param {string} id
 * @returns {string}
 */
declare function approvalToken(id: string): string;
/**
 * Encode a choice as callback_data (`sap:<token>:a`, `sap:<token>:d`,
 * `sap:<token>:s:<key>`). The token namespaces the press to one approval.
 * @param {TelegramApprovalChoice} choice
 * @param {string} token
 * @returns {string}
 */
declare function telegramApprovalCallbackData(choice: TelegramApprovalChoice, token: string): string;
/**
 * Decode approval callback_data into `{ token, ...choice }`. Returns null for
 * anything that is not ours (a stray press from an unrelated keyboard).
 * @param {string | undefined | null} data
 * @returns {(TelegramApprovalChoice & { token: string }) | null}
 */
declare function parseTelegramApprovalCallbackData(data: string | undefined | null): (TelegramApprovalChoice & {
    token: string;
}) | null;
/**
 * True when a delivered callback query is a press on THIS approval's own
 * buttons (matching token), not a stale/foreign press in the same chat.
 * @param {{ data?: string }} callbackQuery
 * @param {TelegramApprovalKeyboardSpec} spec
 * @returns {boolean}
 */
declare function isOwnApprovalPress(callbackQuery: {
    data?: string;
}, spec: TelegramApprovalKeyboardSpec): boolean;
/**
 * Build a Mini App (`web_app`) inline-keyboard button. `url` must be HTTPS.
 * @param {string} text
 * @param {string} url
 * @returns {TelegramInlineKeyboardButton}
 */
declare function webAppButton(text: string, url: string): TelegramInlineKeyboardButton;
/**
 * Build the inline keyboard for an approval prompt.
 * @param {TelegramApprovalKeyboardSpec} spec
 * @returns {TelegramInlineKeyboard}
 */
declare function approvalInlineKeyboard(spec: TelegramApprovalKeyboardSpec): TelegramInlineKeyboard;
/**
 * Who pressed the button, as a stable string (`@username` or the numeric id).
 * @param {{ from?: { id?: number | string; username?: string } }} callbackQuery
 * @returns {string | null}
 */
declare function telegramApproverLabel(callbackQuery: {
    from?: {
        id?: number | string;
        username?: string;
    };
}): string | null;
/**
 * Map a delivered callback query to an approval decision. A press that is not
 * this approval's own (wrong or missing token) or is otherwise unrecognized
 * fails safe: a non-approval (`approved: false`) in approve mode, or an empty
 * selection in select mode. A stale/foreign press can therefore never produce
 * a false approval.
 * @param {{ data?: string; from?: object; message?: { date?: number } }} callbackQuery
 * @param {TelegramApprovalKeyboardSpec} spec
 * @returns {TelegramApprovalDecision | TelegramApprovalSelection}
 */
declare function telegramApprovalDecision(callbackQuery: {
    data?: string;
    from?: object;
    message?: {
        date?: number;
    };
}, spec: TelegramApprovalKeyboardSpec): TelegramApprovalDecision | TelegramApprovalSelection;
/** Decision schema for `mode: "approve"` (mirrors the core approvalDecisionSchema). */
declare const telegramApprovalDecisionSchema: z.ZodObject<{
    approved: z.ZodBoolean;
    note: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    decidedBy: z.ZodNullable<z.ZodString>;
    decidedAt: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
/** Decision schema for `mode: "select"` (mirrors the core approvalSelectionSchema). */
declare const telegramApprovalSelectionSchema: z.ZodObject<{
    selected: z.ZodString;
    notes: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
type TelegramApprovalChoice = TelegramApprovalChoice$1;
type TelegramApprovalOption = TelegramApprovalOption$1;
type TelegramApprovalMode = TelegramApprovalMode$1;
type TelegramApprovalKeyboardSpec = TelegramApprovalKeyboardSpec$1;
type TelegramApprovalDecision = TelegramApprovalDecision$1;
type TelegramApprovalSelection = TelegramApprovalSelection$1;
type TelegramInlineKeyboard = TelegramInlineKeyboard$1;
type TelegramInlineKeyboardButton = TelegramInlineKeyboardButton$1;

export { type TelegramApprovalChoice, type TelegramApprovalDecision, type TelegramApprovalKeyboardSpec, type TelegramApprovalMode, type TelegramApprovalOption, type TelegramApprovalSelection, type TelegramInlineKeyboard, type TelegramInlineKeyboardButton, approvalInlineKeyboard, approvalToken, isOwnApprovalPress, parseTelegramApprovalCallbackData, telegramApprovalCallbackData, telegramApprovalDecision, telegramApprovalDecisionSchema, telegramApprovalSelectionSchema, telegramApproverLabel, webAppButton };

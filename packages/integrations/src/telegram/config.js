// @smithers-type-exports-begin
/** @typedef {import("./TelegramClientTypes.ts").TelegramClientConfig} TelegramClientConfig */
// @smithers-type-exports-end

import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { makeTelegramClient } from "./TelegramClient.js";

/**
 * Module-level Telegram config used by the outbound components
 * (`SendMessage`, `EditMessage`, ...) when no explicit `config` prop is
 * given. `createSmithers({ integrations })` binding lands in a later phase;
 * until then call `configureTelegram(...)` once at workflow setup, or rely
 * on the `SMITHERS_TELEGRAM_BOT_TOKEN` env fallback.
 *
 * @type {TelegramClientConfig | null}
 */
let moduleConfig = null;

/**
 * Register process-wide Telegram config for outbound components.
 * Pass `null` to clear (tests).
 * @param {TelegramClientConfig | null} config
 */
export function configureTelegram(config) {
    moduleConfig = config;
}

/**
 * Resolve the effective Telegram config: explicit prop > `configureTelegram`
 * registry > `SMITHERS_TELEGRAM_BOT_TOKEN` env fallback. Throws
 * `INVALID_INPUT` when no bot token can be found — the error message never
 * includes any token material.
 * @param {Partial<TelegramClientConfig> | undefined} [explicit]
 * @returns {TelegramClientConfig}
 */
export function resolveTelegramConfig(explicit) {
    const envToken = process.env.SMITHERS_TELEGRAM_BOT_TOKEN;
    const base = moduleConfig ?? (envToken ? { botToken: envToken } : null);
    const merged = { ...(base ?? {}), ...(explicit ?? {}) };
    if (!merged.botToken) {
        throw new SmithersError("INVALID_INPUT", "No Telegram bot token configured. Pass config={ botToken } to the component, call configureTelegram({ botToken }), or set SMITHERS_TELEGRAM_BOT_TOKEN.");
    }
    return /** @type {TelegramClientConfig} */ (merged);
}

/**
 * Resolve config and build a client from it (outbound component seam).
 * @param {Partial<TelegramClientConfig> | undefined} [explicit]
 */
export function resolveTelegramClient(explicit) {
    return makeTelegramClient(resolveTelegramConfig(explicit));
}

import { readFileSync } from "node:fs";
import { assertMaxBytes } from "@smithers-orchestrator/db/input-bounds";
import { SmithersError } from "@smithers-orchestrator/errors";

export const CLI_JSON_ARGUMENT_MAX_BYTES = 1024 * 1024;

/**
 * @param {string | undefined} raw
 * @param {string} label
 * @returns {string | undefined}
 */
export function readJsonArgumentPayload(raw, label) {
    if (!raw)
        return undefined;
    if (raw === "-") {
        const payload = readFileSync(0, "utf8");
        assertMaxBytes(label, payload, CLI_JSON_ARGUMENT_MAX_BYTES);
        if (payload.trim().length === 0) {
            throw new SmithersError("INVALID_JSON", `Invalid JSON for ${label}: stdin was empty`);
        }
        return payload;
    }
    return raw;
}

/**
 * @param {string | undefined} raw
 * @param {string} label
 */
export function parseJsonArgument(raw, label) {
    const payload = readJsonArgumentPayload(raw, label);
    if (payload === undefined) {
        return undefined;
    }
    try {
        return JSON.parse(payload);
    }
    catch (err) {
        throw new SmithersError("INVALID_JSON", `Invalid JSON for ${label}: ${err?.message ?? String(err)}`);
    }
}

/**
 * @param {string | undefined} raw
 * @param {string} label
 * @param {(opts: { code: string; message: string; exitCode: number }) => unknown} fail
 */
export function parseJsonInput(raw, label, fail) {
    try {
        return parseJsonArgument(raw, label);
    }
    catch (err) {
        return fail({
            code: err instanceof SmithersError ? err.code : "INVALID_JSON",
            message: err?.message ?? String(err),
            exitCode: 4,
        });
    }
}

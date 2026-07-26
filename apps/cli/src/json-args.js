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
  if (!raw) return undefined;
  if (raw === "-") {
    const payload = readFileSync(0, "utf8");
    assertMaxBytes(label, payload, CLI_JSON_ARGUMENT_MAX_BYTES);
    if (payload.trim().length === 0) {
      throw new SmithersError("INVALID_JSON", `Invalid JSON for ${label}: stdin was empty`);
    }
    return payload;
  }
  assertMaxBytes(label, raw, CLI_JSON_ARGUMENT_MAX_BYTES);
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
  } catch (err) {
    throw new SmithersError("INVALID_JSON", `Invalid JSON for ${label}: ${err?.message ?? String(err)}`);
  }
}

/**
 * Parse a JSON CLI argument into a discriminated result so callers MUST
 * short-circuit on failure. The previous `parseJsonInput(raw, label, fail)`
 * returned `fail()`'s value on error, but under `cli.serve` `fail` (which calls
 * `c.error`) returns a truthy sentinel WITHOUT throwing — so callers that wrote
 * `const x = parseJsonInput(...)` kept running and performed their side effect
 * (signal delivery, run input override, human-answer value) with the error
 * sentinel in place of the parsed JSON. Returning `{ ok }` forces an explicit
 * `if (!parsed.ok) return fail(parsed.error)` at every call site.
 *
 * @param {string | undefined} raw
 * @param {string} label
 * @returns {{ ok: true, value: unknown } | { ok: false, error: { code: string; message: string; exitCode: number } }}
 */
export function tryParseJsonInput(raw, label) {
  try {
    return { ok: true, value: parseJsonArgument(raw, label) };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: err instanceof SmithersError ? err.code : "INVALID_JSON",
        message: err?.message ?? String(err),
        exitCode: 4,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// loadSpecEffect — Effect-based OpenAPI spec loader
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import {
    assertHttpUrl,
    composeAbortSignals,
    fetchWithPolicy,
    HttpClientPolicyError,
    readResponseText,
} from "@smithers-orchestrator/http-client";
import { assertPublicHostname } from "@smithers-orchestrator/http-client/node";
import { parseSpecText } from "./_specHelpers.js";
import { SPEC_SOURCE_URL } from "./specSourceUrl.js";

/** @typedef {import("./OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */
/** @typedef {import("./OpenApiToolsOptions.ts").OpenApiToolsOptions} OpenApiToolsOptions */

const DEFAULT_MAX_SPEC_BYTES = 5 * 1024 * 1024;

/** @param {unknown} configured */
function maxSpecBytes(configured) {
    const value = configured ?? DEFAULT_MAX_SPEC_BYTES;
    if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0) {
        throw new HttpClientPolicyError(
            "INVALID_OPTION",
            "maxSpecBytes must be a non-negative safe integer.",
            { option: "maxSpecBytes" },
        );
    }
    return /** @type {number} */ (value);
}

/**
 * Load an OpenAPI spec from a JSON/YAML string, URL, file path, or object.
 *
 * @param {string | OpenApiSpec} input
 * @param {Pick<OpenApiToolsOptions, "allowedOrigins" | "allowPrivateNetwork" | "maxRedirects" | "maxSpecBytes" | "resolveHostname" | "signal">} [options]
 * @returns {Effect.Effect<OpenApiSpec, unknown>}
 */
export function loadSpecEffect(input, options = {}) {
    if (typeof input === "object" && input !== null) {
        if ("openapi" in input) {
            return Effect.succeed(input);
        }
        return Effect.fail(toSmithersError(
            new Error(
                "Pre-loaded OpenAPI spec object is missing an 'openapi' field. Only OpenAPI 3.x is supported; "
                + "Swagger 2.0 specs (which use a 'swagger' field) must be converted to OpenAPI 3.x first.",
            ),
            "openapi load spec",
        ));
    }
    const str = input;
    // URL
    if (str.startsWith("http://") || str.startsWith("https://")) {
        return Effect.tryPromise({
            try: async (effectSignal) => {
                const responseByteLimit = maxSpecBytes(options.maxSpecBytes);
                const composed = composeAbortSignals(effectSignal, options.signal);
                try {
                    const specUrl = assertHttpUrl(str);
                    const res = await fetchWithPolicy(specUrl, { signal: composed.signal }, {
                        allowedOrigins: options.allowedOrigins,
                        maxRedirects: options.maxRedirects,
                        validateUrl: options.allowPrivateNetwork
                            ? undefined
                            : (candidate) => assertPublicHostname(candidate.hostname, {
                                resolveHostname: options.resolveHostname,
                                signal: composed.signal,
                            }),
                    });
                    if (!res.ok) {
                        await res.body?.cancel().catch(() => undefined);
                        throw new Error(`Failed to fetch OpenAPI spec: ${res.status} ${res.statusText}`);
                    }
                    const text = await readResponseText(res, {
                        maxBytes: responseByteLimit,
                        signal: composed.signal,
                    });
                    const spec = parseSpecText(text);
                    // Remember where the spec came from so a relative server URL
                    // can be resolved against it. Prefer the post-redirect URL.
                    /** @type {Record<PropertyKey, unknown>} */ (spec)[SPEC_SOURCE_URL] = res.url || str;
                    return spec;
                }
                finally {
                    composed.cleanup();
                }
            },
            catch: (cause) => options.signal?.aborted
                ? (options.signal.reason ?? new DOMException("The operation was aborted", "AbortError"))
                : toSmithersError(cause, "openapi fetch spec"),
        });
    }
    // File path or raw JSON/YAML string
    return Effect.try({
        try: () => {
            // Try reading as file first
            let content;
            try {
                content = readFileSync(str, "utf8");
            }
            catch {
                // Not a file — try parsing as raw text
                return parseSpecText(str);
            }
            return parseSpecText(content);
        },
        catch: (cause) => toSmithersError(cause, "openapi load spec"),
    });
}

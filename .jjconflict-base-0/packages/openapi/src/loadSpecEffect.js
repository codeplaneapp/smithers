// ---------------------------------------------------------------------------
// loadSpecEffect — Effect-based OpenAPI spec loader
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { parseSpecText } from "./_specHelpers.js";
import { SPEC_SOURCE_URL } from "./specSourceUrl.js";

/** @typedef {import("./OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */

/**
 * Load an OpenAPI spec from a JSON/YAML string, URL, file path, or object.
 *
 * @param {string | OpenApiSpec} input
 * @returns {Effect.Effect<OpenApiSpec, unknown>}
 */
export function loadSpecEffect(input) {
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
            try: async () => {
                const res = await fetch(str);
                if (!res.ok) {
                    throw new Error(`Failed to fetch OpenAPI spec: ${res.status} ${res.statusText}`);
                }
                const text = await res.text();
                const spec = parseSpecText(text);
                // Remember where the spec came from so a relative server URL
                // can be resolved against it. Prefer the post-redirect URL.
                /** @type {Record<PropertyKey, unknown>} */ (spec)[SPEC_SOURCE_URL] = res.url || str;
                return spec;
            },
            catch: (cause) => toSmithersError(cause, "openapi fetch spec"),
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

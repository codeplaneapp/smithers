// ---------------------------------------------------------------------------
// loadSpecSync — synchronous OpenAPI spec loader
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { parseSpecText } from "./_specHelpers.js";

/** @typedef {import("./OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */

/**
 * Synchronous version for simpler call sites.
 *
 * @param {string | OpenApiSpec} input
 * @returns {OpenApiSpec}
 */
export function loadSpecSync(input) {
    if (typeof input === "object" && input !== null) {
        if ("openapi" in input) {
            return input;
        }
        throw new Error(
            "Pre-loaded OpenAPI spec object is missing an 'openapi' field. Only OpenAPI 3.x is supported; "
            + "Swagger 2.0 specs (which use a 'swagger' field) must be converted to OpenAPI 3.x first.",
        );
    }
    const str = input;
    let content;
    try {
        content = readFileSync(str, "utf8");
    }
    catch {
        return parseSpecText(str);
    }
    return parseSpecText(content);
}

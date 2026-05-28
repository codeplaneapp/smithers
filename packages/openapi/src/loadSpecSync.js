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
    if (typeof input === "object" && input !== null && "openapi" in input) {
        return input;
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

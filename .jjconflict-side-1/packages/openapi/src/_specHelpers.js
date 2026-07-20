// ---------------------------------------------------------------------------
// Shared private helpers for spec parsing
// ---------------------------------------------------------------------------
import { parse as parseYaml } from "yaml";

/** @typedef {import("./HttpMethod.ts").HttpMethod} HttpMethod */
/** @typedef {import("./ParameterObject.ts").ParameterObject} ParameterObject */

/**
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
export function parseSpecText(text) {
    /** @type {unknown} */
    let parsed;
    // Try JSON first
    try {
        parsed = JSON.parse(text);
    }
    catch {
        // Try YAML
        try {
            parsed = parseYaml(text);
        }
        catch {
            throw new Error("Failed to parse OpenAPI spec as JSON or YAML");
        }
    }
    // Swagger 2.0 has materially different shapes for parameters, request
    // bodies, security, and host/basePath. Reject it before the looser shape
    // check below can mistake it for OpenAPI 3.x.
    if (typeof parsed === "object" &&
        parsed !== null &&
        "swagger" in parsed &&
        !("openapi" in parsed)) {
        throw new Error("Swagger 2.0 specs are not supported. Convert the spec to OpenAPI 3.x first.");
    }
    // Validate it looks like an OpenAPI spec
    if (typeof parsed !== "object" ||
        parsed === null ||
        !("openapi" in parsed) ||
        !("paths" in parsed || "info" in parsed)) {
        throw new Error("Parsed content does not appear to be a valid OpenAPI spec (missing openapi/paths/info fields)");
    }
    return /** @type {Record<string, unknown>} */ (parsed);
}
/**
 * Merge path-level and operation-level parameters. Operation-level wins
 * when there is a name+in collision.
 *
 * @param {ParameterObject[]} pathLevel
 * @param {ParameterObject[]} opLevel
 * @returns {ParameterObject[]}
 */
export function mergeParameters(pathLevel, opLevel) {
    const opKeys = new Set(opLevel.map((p) => `${p.in}:${p.name}`));
    const fromPath = pathLevel.filter((p) => !opKeys.has(`${p.in}:${p.name}`));
    return [...fromPath, ...opLevel];
}
/**
 * Generate an operationId from method + path when one is not provided.
 * e.g. GET /pets/{petId} → get_pets_petId
 *
 * @param {HttpMethod} method
 * @param {string} path
 * @returns {string}
 */
export function generateOperationId(method, path) {
    const cleaned = path
        .replace(/\{([^}]+)\}/g, "$1")
        .replace(/[^a-zA-Z0-9]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "");
    return `${method}_${cleaned}`;
}

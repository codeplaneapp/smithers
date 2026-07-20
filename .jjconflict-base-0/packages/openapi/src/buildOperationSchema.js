// ---------------------------------------------------------------------------
// Build a combined Zod schema from operation parameters + requestBody
// ---------------------------------------------------------------------------
import { z } from "zod";
import { isRef } from "./ref-resolver.js";
import { jsonSchemaToZod } from "./jsonSchemaToZod.js";
import { getRequestBodyArgName } from "./getRequestBodyArgName.js";

/** @typedef {import("./OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */
/** @typedef {import("./ParameterObject.ts").ParameterObject} ParameterObject */
/** @typedef {import("./RequestBodyObject.ts").RequestBodyObject} RequestBodyObject */

/**
 * @param {RequestBodyObject | undefined} requestBody
 * @returns {{ mediaType: string; content: NonNullable<RequestBodyObject["content"]>[string] } | undefined}
 */
export function selectRequestBodyContent(requestBody) {
    const content = requestBody?.content;
    if (!content)
        return undefined;
    if (content["application/json"]) {
        return { mediaType: "application/json", content: content["application/json"] };
    }
    const firstEntry = Object.entries(content)[0];
    if (!firstEntry)
        return undefined;
    const [mediaType, mediaContent] = firstEntry;
    return { mediaType, content: mediaContent };
}

/**
 * Build a single Zod object schema for an operation's input, combining:
 * - path parameters
 * - query parameters
 * - header parameters
 * - request body fields
 *
 * @param {ParameterObject[]} parameters
 * @param {RequestBodyObject | undefined} requestBody
 * @param {OpenApiSpec} spec
 * @returns {z.ZodType}
 */
export function buildOperationSchema(parameters, requestBody, spec) {
    const props = {};
    const requiredKeys = [];
    // Parameters (path, query, header)
    for (const param of parameters) {
        if (param.in === "cookie")
            continue; // skip cookies
        let paramSchema = jsonSchemaToZod(param.schema, spec);
        if (param.description && !(param.schema && !isRef(param.schema) && param.schema.description)) {
            paramSchema = paramSchema.describe(param.description);
        }
        if (!param.required) {
            paramSchema = paramSchema.optional();
        }
        else {
            requiredKeys.push(param.name);
        }
        props[param.name] = paramSchema;
    }
    // Request body
    if (requestBody) {
        const selectedContent = selectRequestBodyContent(requestBody);
        if (selectedContent) {
            const bodySchema = selectedContent.content.schema
                ? jsonSchemaToZod(selectedContent.content.schema, spec)
                : z.any();
            // The request body lives under "body" unless an operation parameter
            // already claims that name (or "requestBody"); getRequestBodyArgName
            // resolves a non-colliding key so a param named `body` cannot replace
            // the request body. executeRequest reads from the SAME resolved key.
            const requestBodyArgName = getRequestBodyArgName(parameters);
            if (requestBody.required) {
                props[requestBodyArgName] = bodySchema;
                requiredKeys.push(requestBodyArgName);
            }
            else {
                props[requestBodyArgName] = bodySchema.optional();
            }
        }
    }
    if (Object.keys(props).length === 0) {
        return z.object({});
    }
    return z.object(props);
}

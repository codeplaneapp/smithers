// ---------------------------------------------------------------------------
// OpenAPI JSON Schema → Zod schema conversion
// ---------------------------------------------------------------------------
import { z } from "zod";
import { isRef, resolveRef } from "./ref-resolver.js";

const MAX_SCHEMA_CONVERSION_DEPTH = 1000;

/** @typedef {import("./OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */
/** @typedef {import("./RefObject.ts").RefObject} RefObject */
/** @typedef {import("./SchemaObject.ts").SchemaObject} SchemaObject */

/**
 * Convert an OpenAPI JSON Schema object to a Zod schema.
 * Falls back to z.any() for schemas that cannot be cleanly represented.
 *
 * @param {SchemaObject | RefObject | undefined} schema
 * @param {OpenApiSpec} spec
 * @param {Set<string>} [visited]
 * @param {number} [depth]
 * @returns {z.ZodType}
 */
export function jsonSchemaToZod(schema, spec, visited = new Set(), depth = 0) {
  if (depth > MAX_SCHEMA_CONVERSION_DEPTH) {
    throw new Error(`OpenAPI schema-depth limit exceeded (max ${MAX_SCHEMA_CONVERSION_DEPTH})`);
  }
  if (!schema) return z.any();
  // Resolve $ref
  if (isRef(schema)) {
    const ref = schema.$ref;
    if (visited.has(ref)) {
      // Circular reference — bail to z.any()
      return z.any().describe(`Circular reference: ${ref}`);
    }
    visited.add(ref);
    try {
      const resolved = resolveRef(spec, ref);
      return jsonSchemaToZod(resolved, spec, visited, depth + 1);
    } finally {
      visited.delete(ref);
    }
  }
  const s = schema;
  // allOf — merge into a single object
  if (s.allOf && s.allOf.length > 0) {
    // Build a combined object from all allOf entries
    const schemas = s.allOf.map((sub) => jsonSchemaToZod(sub, spec, visited, depth + 1));
    if (schemas.length === 1) return applyMetadata(schemas[0], s);
    // For multiple schemas, try to intersect them
    let result = schemas[0];
    for (let i = 1; i < schemas.length; i++) {
      result = z.intersection(result, schemas[i]);
    }
    return applyMetadata(result, s);
  }
  // oneOf / anyOf — union
  if (s.oneOf && s.oneOf.length > 0) {
    return buildUnion(s.oneOf, spec, visited, s, depth);
  }
  if (s.anyOf && s.anyOf.length > 0) {
    return buildUnion(s.anyOf, spec, visited, s, depth);
  }
  const type = s.type;
  if (type === "string") {
    return buildString(s);
  }
  if (type === "number" || type === "integer") {
    return buildNumber(s);
  }
  if (type === "boolean") {
    return applyMetadata(z.boolean(), s);
  }
  if (type === "array") {
    const items = jsonSchemaToZod(s.items, spec, visited, depth + 1);
    return applyMetadata(z.array(items), s);
  }
  if (type === "object" || s.properties) {
    return buildObject(s, spec, visited, depth);
  }
  // null type
  if (type === "null") {
    return applyMetadata(z.null(), s);
  }
  // Fallback
  if (s.enum && s.enum.length > 0) {
    return applyMetadata(buildLiteralUnion(s.enum), s);
  }
  const desc = s.description ? `${s.description} (untyped)` : "untyped schema";
  return z.any().describe(desc);
}
// ---------------------------------------------------------------------------
// Type-specific builders
// ---------------------------------------------------------------------------
/**
 * @param {SchemaObject} s
 * @returns {z.ZodType}
 */
function buildString(s) {
  let schema;
  if (s.enum && s.enum.length > 0) {
    const values = s.enum;
    schema = z.enum(values);
  } else {
    let str = z.string();
    if (s.minLength !== undefined) str = str.min(s.minLength);
    if (s.maxLength !== undefined) str = str.max(s.maxLength);
    if (s.pattern) str = str.regex(new RegExp(s.pattern));
    if (s.format === "email") str = str.email();
    if (s.format === "url" || s.format === "uri") str = str.url();
    schema = str;
  }
  return applyMetadata(schema, s);
}
/**
 * @param {SchemaObject} s
 * @returns {z.ZodType}
 */
function buildNumber(s) {
  let num = z.number();
  if (s.type === "integer") num = num.int();
  if (s.minimum !== undefined) num = num.min(s.minimum);
  if (s.maximum !== undefined) num = num.max(s.maximum);
  if (s.enum && s.enum.length > 0) {
    num = z.intersection(num, buildLiteralUnion(s.enum));
  }
  return applyMetadata(num, s);
}
/**
 * @param {SchemaObject} s
 * @param {OpenApiSpec} spec
 * @param {Set<string>} visited
 * @param {number} depth
 * @returns {z.ZodType}
 */
function buildObject(s, spec, visited, depth) {
  const props = {};
  const required = new Set(s.required ?? []);
  for (const [key, propSchema] of Object.entries(s.properties ?? {})) {
    let zodProp = jsonSchemaToZod(propSchema, spec, visited, depth + 1);
    if (!required.has(key)) {
      zodProp = zodProp.optional();
    }
    props[key] = zodProp;
  }
  let obj = z.object(props);
  if (typeof s.additionalProperties === "object" && s.additionalProperties !== null) {
    obj = obj.catchall(jsonSchemaToZod(s.additionalProperties, spec, visited, depth + 1));
  } else if (s.additionalProperties === true || s.additionalProperties === undefined) {
    // Allow additional properties. This MUST apply even when the schema
    // declares no `properties`: a free-form body like `{ type: "object" }`
    // would otherwise become `z.object({})`, which STRIPS every key on parse,
    // so the LLM-supplied request body is silently reduced to `{}` before it
    // ever reaches the upstream API. A catchall preserves unknown keys.
    obj = obj.catchall(z.unknown());
  }
  return applyMetadata(obj, s);
}
/**
 * @param {Array<SchemaObject | RefObject>} variants
 * @param {OpenApiSpec} spec
 * @param {Set<string>} visited
 * @param {SchemaObject} parent
 * @param {number} depth
 * @returns {z.ZodType}
 */
function buildUnion(variants, spec, visited, parent, depth) {
  const schemas = variants.map((v) => jsonSchemaToZod(v, spec, visited, depth + 1));
  if (schemas.length === 0) return z.any();
  if (schemas.length === 1) return applyMetadata(schemas[0], parent);
  return applyMetadata(z.union(schemas), parent);
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * @param {unknown[]} values
 * @returns {z.ZodType}
 */
function buildLiteralUnion(values) {
  const literals = values.map((value) => z.literal(value));
  if (literals.length === 1) return literals[0];
  return z.union(literals);
}
/**
 * @param {z.ZodType} schema
 * @param {SchemaObject} s
 * @returns {z.ZodType}
 */
function maybeDescribe(schema, s) {
  if (s.description) return schema.describe(s.description);
  return schema;
}
/**
 * @param {z.ZodType} schema
 * @param {SchemaObject} s
 * @returns {z.ZodType}
 */
function applyMetadata(schema, s) {
  return maybeDescribe(maybeNullable(maybeDefault(schema, s), s), s);
}
/**
 * @param {z.ZodType} schema
 * @param {SchemaObject} s
 * @returns {z.ZodType}
 */
function maybeNullable(schema, s) {
  if (s.nullable) return schema.nullable();
  return schema;
}
/**
 * @param {z.ZodType} schema
 * @param {SchemaObject} s
 * @returns {z.ZodType}
 */
function maybeDefault(schema, s) {
  if (s.default !== undefined) return schema.default(s.default);
  return schema;
}

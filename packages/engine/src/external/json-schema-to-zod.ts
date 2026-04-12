/**
 * Convert JSON Schema to Zod schemas.
 *
 * Handles standard JSON Schema patterns:
 * - $defs for nested model references
 * - anyOf + null for Optional fields → .nullable()
 */

import { z } from "zod";

type JsonSchema = Record<string, any>;

/**
 * Convert a JSON Schema to a Zod object schema.
 */
export function jsonSchemaToZod(rootSchema: JsonSchema): z.ZodObject<any> {
  const result = convertNode(rootSchema, rootSchema, new Set());
  if (result instanceof z.ZodObject) return result;
  return z.object({}).catchall(z.unknown());
}

function convertNode(
  node: JsonSchema | undefined,
  root: JsonSchema,
  visited: Set<string>,
): z.ZodType {
  if (!node) return z.any();

  if (node.$ref && typeof node.$ref === "string") {
    const ref = node.$ref as string;
    if (visited.has(ref)) {
      return z.any().describe(`Circular reference: ${ref}`);
    }
    visited.add(ref);
    const resolved = resolveJsonPointer(root, ref);
    const result = convertNode(resolved, root, visited);
    visited.delete(ref);
    return result;
  }

  if (node.allOf && Array.isArray(node.allOf) && node.allOf.length > 0) {
    const schemas = node.allOf.map((sub: JsonSchema) => convertNode(sub, root, visited));
    if (schemas.length === 1) return maybeDescribe(schemas[0]!, node);
    let result: z.ZodType = schemas[0]!;
    for (let i = 1; i < schemas.length; i++) {
      result = z.intersection(result, schemas[i]!);
    }
    return maybeDescribe(result, node);
  }

  if (node.anyOf && Array.isArray(node.anyOf) && node.anyOf.length > 0) {
    return buildAnyOf(node.anyOf, root, visited, node);
  }

  if (node.oneOf && Array.isArray(node.oneOf) && node.oneOf.length > 0) {
    return buildUnion(node.oneOf, root, visited, node);
  }

  const type = node.type;

  if (type === "string") return buildString(node);
  if (type === "number" || type === "integer") return buildNumber(node);
  if (type === "boolean") return maybeDescribe(z.boolean(), node);

  if (type === "array") {
    const items = convertNode(node.items, root, visited);
    return maybeDescribe(z.array(items), node);
  }

  if (type === "object" || node.properties) {
    return buildObject(node, root, visited);
  }

  if (type === "null") return z.null();

  return z.any();
}

function buildAnyOf(
  variants: JsonSchema[],
  root: JsonSchema,
  visited: Set<string>,
  parent: JsonSchema,
): z.ZodType {
  const nullIdx = variants.findIndex((v) => v.type === "null");
  if (nullIdx !== -1 && variants.length === 2) {
    const other = variants[1 - nullIdx]!;
    const inner = convertNode(other, root, visited);
    const result = inner.nullable();
    return parent.default !== undefined ? maybeDefault(maybeDescribe(result, parent), parent) : maybeDescribe(result, parent);
  }
  return buildUnion(variants, root, visited, parent);
}

function buildString(s: JsonSchema): z.ZodType {
  let schema: z.ZodType;
  if (s.enum && Array.isArray(s.enum) && s.enum.length > 0) {
    schema = z.enum(s.enum as [string, ...string[]]);
  } else {
    let str = z.string();
    if (s.minLength !== undefined) str = str.min(s.minLength);
    if (s.maxLength !== undefined) str = str.max(s.maxLength);
    if (s.pattern) str = str.regex(new RegExp(s.pattern));
    schema = str;
  }
  return maybeDescribe(maybeNullable(maybeDefault(schema, s), s), s);
}

function buildNumber(s: JsonSchema): z.ZodType {
  let num = z.number();
  if (s.type === "integer") num = num.int();
  if (s.minimum !== undefined) num = num.min(s.minimum);
  if (s.maximum !== undefined) num = num.max(s.maximum);
  return maybeDescribe(maybeNullable(maybeDefault(num, s), s), s);
}

function buildObject(
  s: JsonSchema,
  root: JsonSchema,
  visited: Set<string>,
): z.ZodType {
  const props: Record<string, z.ZodType> = {};
  const required = new Set<string>(s.required ?? []);

  for (const [key, propSchema] of Object.entries(s.properties ?? {})) {
    let zodProp = convertNode(propSchema as JsonSchema, root, visited);
    if (!required.has(key)) {
      zodProp = zodProp.optional();
    }
    props[key] = zodProp;
  }

  const obj = z.object(props);
  return maybeDescribe(maybeNullable(obj, s), s);
}

function buildUnion(
  variants: JsonSchema[],
  root: JsonSchema,
  visited: Set<string>,
  parent: JsonSchema,
): z.ZodType {
  const schemas = variants.map((v) => convertNode(v, root, visited));
  if (schemas.length === 0) return z.any();
  if (schemas.length === 1) return maybeDescribe(schemas[0]!, parent);
  return maybeDescribe(z.union(schemas as [z.ZodType, z.ZodType, ...z.ZodType[]]), parent);
}

function maybeDescribe(schema: z.ZodType, s: JsonSchema): z.ZodType {
  if (s.description) return schema.describe(s.description);
  return schema;
}

function maybeNullable(schema: z.ZodType, s: JsonSchema): z.ZodType {
  if (s.nullable) return schema.nullable();
  return schema;
}

function maybeDefault(schema: z.ZodType, s: JsonSchema): z.ZodType {
  if (s.default !== undefined) return schema.default(s.default);
  return schema;
}

function resolveJsonPointer(root: JsonSchema, ref: string): JsonSchema {
  if (!ref.startsWith("#/")) {
    throw new Error(`Unsupported $ref format: ${ref}`);
  }
  const parts = ref.slice(2).split("/");
  let current: any = root;
  for (const part of parts) {
    const decoded = part.replace(/~1/g, "/").replace(/~0/g, "~");
    current = current?.[decoded];
    if (current === undefined) {
      throw new Error(`Could not resolve $ref: ${ref}`);
    }
  }
  return current;
}

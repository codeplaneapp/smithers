import { toJSONSchema, type ZodType } from "zod";
import { zodSchemaToJsonExample } from "@smithers-orchestrator/components/zod-to-example";
import type { SafeSchema } from "./fakeAgent.ts";

type JsonSchema = {
  type?: string | readonly string[];
  const?: unknown;
  default?: unknown;
  examples?: readonly unknown[];
  enum?: readonly unknown[];
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minItems?: number;
  maxItems?: number;
  required?: readonly string[];
  properties?: Readonly<Record<string, JsonSchema>>;
  items?: JsonSchema;
  prefixItems?: readonly JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  anyOf?: readonly JsonSchema[];
  oneOf?: readonly JsonSchema[];
  allOf?: readonly JsonSchema[];
};

function stringForFormat(format: string | undefined): string {
  switch (format) {
    case "email":
      return "test@example.com";
    case "uri":
    case "url":
      return "https://example.com";
    case "uuid":
      return "00000000-0000-4000-8000-000000000000";
    case "date-time":
      return "2020-01-01T00:00:00.000Z";
    case "date":
      return "2020-01-01";
    case "time":
      return "00:00:00Z";
    case "ipv4":
      return "127.0.0.1";
    case "ipv6":
      return "::1";
    case "hostname":
      return "example.com";
    default:
      return "string";
  }
}

function numberFromSchema(schema: JsonSchema): number {
  let value = schema.minimum ?? 0;
  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
    value = schema.exclusiveMinimum + 1;
  }
  if (schema.maximum !== undefined && value > schema.maximum) value = schema.maximum;
  if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
    value = schema.exclusiveMaximum - 1;
  }
  return value;
}

function jsonSchemaExample(schema: JsonSchema, depth = 0): unknown {
  if (depth > 12) return null;
  if ("const" in schema) return schema.const;
  if ("default" in schema) return schema.default;
  if (schema.examples?.length) return schema.examples[0];
  if (schema.enum?.length) return schema.enum[0];
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives?.length) return jsonSchemaExample(alternatives[0], depth + 1);
  if (schema.allOf?.length) {
    const values = schema.allOf.map((entry) => jsonSchemaExample(entry, depth + 1));
    if (values.every((value) => value && typeof value === "object" && !Array.isArray(value))) {
      return Object.assign({}, ...values);
    }
    return values[0];
  }
  const type = Array.isArray(schema.type)
    ? (schema.type.find((candidate) => candidate !== "null") ?? schema.type[0])
    : schema.type;
  switch (type) {
    case "null":
      return null;
    case "boolean":
      return false;
    case "integer":
      return Math.trunc(numberFromSchema(schema));
    case "number":
      return numberFromSchema(schema);
    case "array": {
      if (schema.prefixItems?.length) {
        return schema.prefixItems.map((item) => jsonSchemaExample(item, depth + 1));
      }
      const length = schema.maxItems === 0 ? 0 : Math.max(1, schema.minItems ?? 0);
      return Array.from({ length }, () => jsonSchemaExample(schema.items ?? {}, depth + 1));
    }
    case "object": {
      const output: Record<string, unknown> = {};
      for (const key of schema.required ?? []) {
        output[key] = jsonSchemaExample(schema.properties?.[key] ?? {}, depth + 1);
      }
      return output;
    }
    case "string":
    default: {
      let value = stringForFormat(schema.format);
      const minimum = schema.minLength ?? 0;
      if (value.length < minimum) value += "a".repeat(minimum - value.length);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        value = value.slice(0, schema.maxLength);
      }
      return value;
    }
  }
}

function formatIssues(issues: readonly unknown[]): string {
  return issues
    .map((issue) =>
      issue && typeof issue === "object" && "message" in issue
        ? String((issue as { message?: unknown }).message)
        : JSON.stringify(issue),
    )
    .join("; ");
}

export function schemaMock<T>(schema: SafeSchema<T>): T {
  const first = JSON.parse(zodSchemaToJsonExample(schema as Parameters<typeof zodSchemaToJsonExample>[0]));
  const firstResult = schema.safeParse(first);
  if (firstResult.success) return firstResult.data;

  const jsonSchema = toJSONSchema(schema as unknown as ZodType) as JsonSchema;
  const candidate = jsonSchemaExample(jsonSchema);
  const result = schema.safeParse(candidate);
  if (result.success) return result.data;
  throw new TypeError(`Could not generate a valid schema-aware mock: ${formatIssues(result.error.issues)}`);
}

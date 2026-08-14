import { toJSONSchema, type ZodType } from "zod";
import { zodSchemaToJsonExample } from "@smthrs/components/zod-to-example";
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
  multipleOf?: number;
  pattern?: string;
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

function nextRepresentable(value: number, direction: 1 | -1): number {
  if (!Number.isFinite(value)) return value;
  if (value === 0) return direction === 1 ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value);
  let bits = view.getBigUint64(0);
  bits += (value >= 0 ? direction : -direction) === 1 ? 1n : -1n;
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  while (right !== 0n) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left < 0n ? -left : left;
}

/**
 * JSON numbers are finite decimals. Reduce the decimal multiple to p/q; an
 * integer n is a multiple of p/q exactly when n is a multiple of p after the
 * fraction is reduced.
 */
function integerStepFromMultiple(multiple: number): number {
  const [mantissa, exponentText] = multiple.toString().toLowerCase().split("e");
  const exponent = Number(exponentText ?? 0);
  const [whole, fraction = ""] = mantissa.split(".");
  const digits = `${whole}${fraction}`.replace(/^\+/, "");
  let numerator = BigInt(digits);
  let denominator = 1n;
  const scale = fraction.length - exponent;
  if (scale > 0) denominator = 10n ** BigInt(scale);
  else if (scale < 0) numerator *= 10n ** BigInt(-scale);
  const divisor = greatestCommonDivisor(numerator, denominator);
  return Number((numerator < 0n ? -numerator : numerator) / divisor);
}

function numberFromSchema(schema: JsonSchema, integer: boolean): number {
  let lower = schema.minimum ?? Number.NEGATIVE_INFINITY;
  let upper = schema.maximum ?? Number.POSITIVE_INFINITY;
  if (schema.exclusiveMinimum !== undefined) {
    lower = Math.max(
      lower,
      integer ? Math.floor(schema.exclusiveMinimum) + 1 : nextRepresentable(schema.exclusiveMinimum, 1),
    );
  }
  if (schema.exclusiveMaximum !== undefined) {
    upper = Math.min(
      upper,
      integer ? Math.ceil(schema.exclusiveMaximum) - 1 : nextRepresentable(schema.exclusiveMaximum, -1),
    );
  }
  if (integer) {
    lower = Math.ceil(lower);
    upper = Math.floor(upper);
  }
  const multiple = schema.multipleOf && schema.multipleOf > 0 ? Math.abs(schema.multipleOf) : integer ? 1 : null;
  if (multiple !== null) {
    if (integer) {
      const step = integerStepFromMultiple(multiple);
      if (!Number.isFinite(step) || step <= 0) {
        throw new TypeError("JSON Schema multipleOf cannot produce a representable integer");
      }
      const firstMultiplier = Number.isFinite(lower) ? Math.ceil(lower / step) : 0;
      const lastMultiplier = Number.isFinite(upper) ? Math.floor(upper / step) : Infinity;
      const multiplier = firstMultiplier <= 0 && lastMultiplier >= 0 ? 0 : firstMultiplier;
      const value = multiplier * step;
      if (firstMultiplier > lastMultiplier || value < lower || value > upper || !Number.isInteger(value)) {
        throw new TypeError("JSON Schema numeric constraints have no representable integer multiple");
      }
      return value;
    }
    let firstMultiplier = Number.isFinite(lower) ? Math.ceil(lower / multiple) : 0;
    let lastMultiplier = Number.isFinite(upper) ? Math.floor(upper / multiple) : Infinity;
    if (Number.isFinite(lower) && (firstMultiplier - 1) * multiple >= lower) firstMultiplier -= 1;
    if (Number.isFinite(upper) && (lastMultiplier + 1) * multiple <= upper) lastMultiplier += 1;
    let multiplier = firstMultiplier <= 0 && lastMultiplier >= 0 ? 0 : firstMultiplier;
    let value = multiplier * multiple;
    if (firstMultiplier > lastMultiplier || value < lower || value > upper) {
      throw new TypeError("JSON Schema numeric constraints have no representable multiple");
    }
    return value;
  }
  if (lower > upper) throw new TypeError("JSON Schema numeric constraints describe an empty interval");
  if (lower <= 0 && upper >= 0) return 0;
  if (Number.isFinite(lower) && Number.isFinite(upper)) {
    const midpoint = lower + (upper - lower) / 2;
    return midpoint >= lower && midpoint <= upper ? midpoint : lower;
  }
  return Number.isFinite(lower) ? lower : Number.isFinite(upper) ? upper : 0;
}

function characterFromClass(source: string): string {
  const negated = source.startsWith("^");
  const body = negated ? source.slice(1) : source;
  const candidates = ["a", "A", "0", "_", "-", " "];
  let expression: RegExp;
  try {
    expression = new RegExp(`^[${source}]$`);
  } catch {
    return "a";
  }
  return candidates.find((candidate) => expression.test(candidate)) ?? (negated ? "a" : (body[0] ?? "a"));
}

/**
 * Produce the shortest useful witness for common JSON-Schema regexes. The
 * final safeParse remains authoritative; unsupported regex features simply
 * fall through to the other candidates instead of being trusted blindly.
 */
function stringForPattern(pattern: string): string | null {
  const source = pattern.replace(/^\^/, "").replace(/\$$/, "");
  const pieces: string[] = [];
  for (let index = 0; index < source.length;) {
    let token = "";
    const char = source[index];
    if (char === "\\") {
      const escaped = source[index + 1];
      token = escaped === "d" ? "0" : escaped === "w" ? "a" : escaped === "s" ? " " : (escaped ?? "");
      index += 2;
    } else if (char === "[") {
      const end = source.indexOf("]", index + 1);
      if (end < 0) return null;
      token = characterFromClass(source.slice(index + 1, end));
      index = end + 1;
    } else if (char === ".") {
      token = "a";
      index += 1;
    } else if ("()|".includes(char)) {
      // Choose the first simple alternative/group. Complex constructs are
      // validated below and can fall back without throwing.
      index += 1;
      continue;
    } else {
      token = char;
      index += 1;
    }
    let count = 1;
    if (source[index] === "*") {
      count = 0;
      index += 1;
    } else if (source[index] === "?") {
      count = 0;
      index += 1;
    } else if (source[index] === "+") {
      index += 1;
    } else if (source[index] === "{") {
      const end = source.indexOf("}", index + 1);
      const minimum = end < 0 ? NaN : Number(source.slice(index + 1, end).split(",")[0]);
      if (!Number.isFinite(minimum)) return null;
      count = minimum;
      index = end + 1;
    }
    pieces.push(token.repeat(count));
  }
  const value = pieces.join("");
  try {
    return new RegExp(pattern).test(value) ? value : null;
  } catch {
    return null;
  }
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
      return numberFromSchema(schema, true);
    case "number":
      return numberFromSchema(schema, false);
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
      let value = (schema.pattern ? stringForPattern(schema.pattern) : null) ?? stringForFormat(schema.format);
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
  try {
    const first = JSON.parse(zodSchemaToJsonExample(schema as Parameters<typeof zodSchemaToJsonExample>[0]));
    const firstResult = schema.safeParse(first);
    if (firstResult.success) return firstResult.data;
  } catch {
    // Primitive schemas and refinements unsupported by the legacy example
    // generator must reach the JSON-Schema fallback below.
  }

  const jsonSchema = toJSONSchema(schema as unknown as ZodType) as JsonSchema;
  const candidate = jsonSchemaExample(jsonSchema);
  const result = schema.safeParse(candidate);
  if (result.success) return result.data;
  throw new TypeError(`Could not generate a valid schema-aware mock: ${formatIssues(result.error.issues)}`);
}

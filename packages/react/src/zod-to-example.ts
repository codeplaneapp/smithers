import type { z } from "zod";

export function zodSchemaToJsonExample(schema: z.ZodObject<any>): string {
  const example: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    example[key] = zodFieldToExample(field as z.ZodTypeAny);
  }
  return JSON.stringify(example, null, 2);
}

function zodFieldToExample(field: z.ZodTypeAny): unknown {
  const anyField = field as any;
  const def = anyField._zod?.def ?? anyField._def;
  if (!def) return "value";
  const description =
    anyField.description ??
    anyField._def?.description ??
    anyField._zod?.bag?.description ??
    def.description ??
    "";

  switch (def.type ?? def.typeName) {
    case "string":
    case "ZodString":
      return description || "string";
    case "number":
    case "ZodNumber":
      return 0;
    case "boolean":
    case "ZodBoolean":
      return false;
    case "array":
    case "ZodArray":
      return [zodFieldToExample(def.element ?? def.type)];
    case "enum":
    case "ZodEnum":
      return Array.isArray(def.values)
        ? def.values[0] ?? "enum"
        : Object.keys(def.entries ?? {})[0] ?? "enum";
    case "object":
    case "ZodObject": {
      const shape = (field as z.ZodObject<any>).shape;
      const value: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(shape ?? {})) {
        value[key] = zodFieldToExample(child as z.ZodTypeAny);
      }
      return value;
    }
    case "nullable":
    case "optional":
    case "ZodNullable":
    case "ZodOptional":
      return zodFieldToExample(def.innerType);
    default:
      return description || "value";
  }
}

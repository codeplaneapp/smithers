import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";

// Keywords OpenAI / Codex strict structured output rejects. Zod v4's
// toJSONSchema emits these for `.default()`, integer bounds, and the meta
// header; leaving them in makes codex discard the schema and fall back to a
// free-form (prose) final message.
const STRIP_KEYS = ["default", "$schema", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "format"];

/**
 * Make every object node strict the way OpenAI / Codex structured output
 * requires: `type: "object"`, `additionalProperties: false`, and every
 * declared property listed in `required` (truly-optional fields must be
 * modeled as nullable). Mirrors `sanitizeForOpenAI` in @smithers-orchestrator/
 * agents, kept local so apps/review takes no extra workspace dependency.
 */
function sanitizeForOpenAI(node: unknown): void {
  if (node == null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  for (const key of STRIP_KEYS) delete obj[key];
  if ("additionalProperties" in obj && !("type" in obj)) obj.type = "object";
  if (obj.type === "object" && obj.additionalProperties !== false) obj.additionalProperties = false;
  if (obj.additionalProperties === false && obj.properties != null && typeof obj.properties === "object") {
    obj.required = Object.keys(obj.properties as Record<string, unknown>);
  }
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) for (const item of value) sanitizeForOpenAI(item);
    else if (typeof value === "object" && value !== null) sanitizeForOpenAI(value);
  }
}

/**
 * Convert a Zod schema to a Codex-compatible JSON Schema and write it to a
 * temp file, returning the path. Codex enforces the file passed via
 * `--output-schema`, which is how a ChatGPT-subscription review run produces
 * the structured JSON the pipeline needs (gpt-5.5 otherwise emits prose, and
 * this smithers build does not auto-wire `--output-schema` for codex).
 */
export function writeOpenAiSchemaFile(schema: z.ZodType): string {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  sanitizeForOpenAI(jsonSchema);
  const file = join(tmpdir(), `smithers-review-schema-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify(jsonSchema), "utf8");
  return file;
}

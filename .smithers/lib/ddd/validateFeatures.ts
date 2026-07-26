import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod/v4";
import { dddRoot } from "./dddRoot.ts";
import { type Feature, featuresSchema } from "./featuresSchema.ts";

export type ValidateFeaturesOptions = {
  /** Missing features.json means "new repo": return an empty spec instead of failing. */
  allowMissing?: boolean;
};

/**
 * Reproducible gate for docs-driven-development: features.json is the spec
 * source of truth, so validate it against the shared schema and assert ids are
 * unique. Throws with a readable message on any failure.
 */
export function validateFeatures(root: string = dddRoot(), options: ValidateFeaturesOptions = {}): Feature[] {
  const featuresPath = resolve(root, ".smithers/spec/features.json");

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(featuresPath, "utf8"));
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (options.allowMissing && code === "ENOENT") return [];
    throw new Error(`could not read/parse ${featuresPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const parsed = featuresSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`features.json does not match the schema:\n${z.prettifyError(parsed.error)}`);
  }

  const ids = parsed.data.map((feature) => feature.id);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length > 0) {
    throw new Error(`duplicate feature ids: ${[...new Set(duplicates)].join(", ")}`);
  }

  return parsed.data;
}

if (import.meta.main) {
  try {
    const features = validateFeatures();
    console.log(`ddd validate passed: ${features.length} features, all ids unique.`);
  } catch (error) {
    console.error(`ddd validate failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

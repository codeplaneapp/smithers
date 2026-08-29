import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v4";

export const BUG_CLASSES = [
  "missing-await",
  "off-by-one-boundary",
  "sql-injection",
  "resource-leak",
  "deleted-null-check",
  "tautological-test",
  "cross-file-signature-mismatch",
] as const;

export const seededBugSeveritySchema = z.enum(["critical", "major", "minor", "info"]);
export const seededBugCategorySchema = z.enum([
  "correctness",
  "security",
  "performance",
  "data-loss",
  "tests",
  "docs",
  "style",
  "other",
]);
export const bugClassSchema = z.enum(BUG_CLASSES);

export const seededBugLabelSchema = z
  .object({
    fixture: z.string().min(1),
    clean: z.literal(false),
    bugClass: bugClassSchema,
    category: seededBugCategorySchema,
    severity: seededBugSeveritySchema,
    file: z.string().min(1),
    line: z.number().int().positive(),
    description: z.string().min(1),
  })
  .strict();

export const cleanControlLabelSchema = z
  .object({
    fixture: z.string().min(1),
    clean: z.literal(true),
    description: z.string().min(1),
  })
  .strict();

export const plantedBugSchema = z.discriminatedUnion("clean", [seededBugLabelSchema, cleanControlLabelSchema]);

export type BugClass = z.infer<typeof bugClassSchema>;
export type SeededBugSeverity = z.infer<typeof seededBugSeveritySchema>;
export type SeededBugCategory = z.infer<typeof seededBugCategorySchema>;
export type SeededBugLabel = z.infer<typeof seededBugLabelSchema>;
export type CleanControlLabel = z.infer<typeof cleanControlLabelSchema>;
export type PlantedBugLabel = z.infer<typeof plantedBugSchema>;

export function loadCorpus(corpusDir = join(import.meta.dir, "corpus")): PlantedBugLabel[] {
  return readdirSync(corpusDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .map((fixture) => {
      const labelPath = join(corpusDir, fixture, "label.json");
      const parsed = plantedBugSchema.parse(JSON.parse(readFileSync(labelPath, "utf8")));
      if (parsed.fixture !== fixture) {
        throw new Error(`${labelPath} fixture field must equal directory name "${fixture}"`);
      }
      return parsed;
    });
}

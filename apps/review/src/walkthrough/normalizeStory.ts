import type { ChangedFile } from "./changedFileSchema";
import { describeChange } from "./describeChange";
import { fallbackStory } from "./fallbackStory";
import { storySchema, type Story, type StoryChapter } from "./storySchema";

/**
 * Repair a narrator story before rendering. Invariant afterwards: every
 * changed file appears in exactly one chapter, and every chapter file is a
 * real changed file. Unknown paths are dropped, duplicates keep their first
 * chapter, files the narrator missed land in a final "Everything else"
 * chapter, and an unusable story falls back to the deterministic one.
 */
export function normalizeStory(candidate: unknown, files: ChangedFile[]): Story {
  const fallback = fallbackStory(files);
  const parsed = storySchema.safeParse(candidate ?? {});
  if (!parsed.success) return fallback;

  const known = new Set(files.map((file) => file.path));
  const seen = new Set<string>();
  const chapters: StoryChapter[] = [];
  for (const raw of parsed.data.chapters) {
    const kept: StoryChapter["files"] = [];
    for (const file of raw.files) {
      const path = file.path.trim();
      if (!known.has(path) || seen.has(path)) continue;
      seen.add(path);
      kept.push({ path, role: file.role.trim(), narrative: file.narrative.trim() });
    }
    if (kept.length === 0) continue;
    chapters.push({
      title: raw.title.trim() || `Chapter ${chapters.length + 1}`,
      narrative: raw.narrative.trim(),
      files: kept,
    });
  }
  if (chapters.length === 0) return fallback;

  const missing = files.filter((file) => !seen.has(file.path));
  if (missing.length > 0) {
    chapters.push({
      title: "Everything else",
      narrative: "Changes the story above did not cover.",
      files: missing.map((file) => ({ path: file.path, role: describeChange(file), narrative: "" })),
    });
  }

  return {
    headline: parsed.data.headline.trim() || fallback.headline,
    synopsis: parsed.data.synopsis.trim() || fallback.synopsis,
    chapters,
  };
}

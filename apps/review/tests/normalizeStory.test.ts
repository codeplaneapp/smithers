import { describe, expect, test } from "bun:test";
import type { ChangedFile } from "../src/walkthrough/changedFileSchema";
import { normalizeStory } from "../src/walkthrough/normalizeStory";

function file(path: string, insertions = 1): ChangedFile {
  return { path, status: "modified", insertions, deletions: 0, diff: "", reviewed: true, excludeReason: "" };
}

const files = [file("src/a.ts", 10), file("src/b.ts", 5), file("src/c.ts", 1)];

describe("normalizeStory", () => {
  test("keeps narrator order, drops unknown paths, dedupes, appends missing files", () => {
    const story = normalizeStory(
      {
        headline: "Adds the thing",
        synopsis: "First the core, then the rest.",
        chapters: [
          {
            title: "The core",
            narrative: "Start here.",
            files: [
              { path: "src/b.ts", role: "the heart", narrative: " Replaces the old heart with a stronger one. " },
              { path: "src/invented.ts", role: "does not exist" },
            ],
          },
          {
            title: "Repeat",
            narrative: "Mentions b again.",
            files: [{ path: "src/b.ts", role: "duplicate" }, { path: "src/a.ts", role: "support" }],
          },
        ],
      },
      files,
    );

    expect(story.headline).toBe("Adds the thing");
    expect(story.chapters.map((chapter) => chapter.title)).toEqual(["The core", "Repeat", "Everything else"]);
    expect(story.chapters[0].files).toEqual([{ path: "src/b.ts", role: "the heart", narrative: "Replaces the old heart with a stronger one." }]);
    expect(story.chapters[1].files).toEqual([{ path: "src/a.ts", role: "support", narrative: "" }]);
    expect(story.chapters[2].files.map((entry) => entry.path)).toEqual(["src/c.ts"]);
  });

  test("every changed file ends up in exactly one chapter", () => {
    const story = normalizeStory(
      { headline: "", synopsis: "", chapters: [{ title: "Partial", narrative: "", files: [{ path: "src/c.ts", role: "" }] }] },
      files,
    );
    const covered = story.chapters.flatMap((chapter) => chapter.files.map((entry) => entry.path));
    expect([...covered].sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(new Set(covered).size).toBe(covered.length);
  });

  test("falls back when the story is null, malformed, or covers nothing", () => {
    for (const candidate of [null, "not a story", { chapters: [{ title: "x", narrative: "", files: [{ path: "nope.ts", role: "" }] }] }]) {
      const story = normalizeStory(candidate, files);
      expect(story.chapters.length).toBeGreaterThan(0);
      const covered = story.chapters.flatMap((chapter) => chapter.files.map((entry) => entry.path));
      expect([...covered].sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    }
  });

  test("fills empty headline and synopsis from the fallback", () => {
    const story = normalizeStory(
      { headline: " ", synopsis: "", chapters: [{ title: "Core", narrative: "", files: [{ path: "src/a.ts", role: "" }] }] },
      files,
    );
    expect(story.headline).toContain("3 file(s) changed");
    expect(story.synopsis.length).toBeGreaterThan(0);
  });
});

import { z } from "zod/v4";

// One permissive shape for all block kinds (the narrator's structured output
// is validated loosely here; normalizeStory enforces the real invariants).
// kind "prose" uses text; "diff" uses path + intro; "diagram" uses title + mermaid.
const storyBlockSchema = z.object({
  kind: z.string().max(32).default("prose"),
  text: z.string().max(20_000).default(""),
  path: z.string().max(1_024).default(""),
  intro: z.string().max(4_000).default(""),
  title: z.string().max(500).default(""),
  mermaid: z.string().max(20_000).default(""),
});

const storyChapterSchema = z.object({
  title: z.string().max(500).default(""),
  blocks: z.array(storyBlockSchema).max(5_000).default([]),
});

export const storySchema = z.object({
  headline: z.string().max(500).default(""),
  synopsis: z.string().max(4_000).default(""),
  chapters: z.array(storyChapterSchema).max(200).default([]),
});

export type Story = z.infer<typeof storySchema>;
export type StoryChapter = z.infer<typeof storyChapterSchema>;
export type StoryBlock = z.infer<typeof storyBlockSchema>;

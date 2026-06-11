import { z } from "zod/v4";

// One permissive shape for all block kinds (the narrator's structured output
// is validated loosely here; normalizeStory enforces the real invariants).
// kind "prose" uses text; "diff" uses path + intro; "diagram" uses title + mermaid.
const storyBlockSchema = z.object({
  kind: z.string().default("prose"),
  text: z.string().default(""),
  path: z.string().default(""),
  intro: z.string().default(""),
  title: z.string().default(""),
  mermaid: z.string().default(""),
});

const storyChapterSchema = z.object({
  title: z.string().default(""),
  blocks: z.array(storyBlockSchema).default([]),
});

export const storySchema = z.object({
  headline: z.string().default(""),
  synopsis: z.string().default(""),
  chapters: z.array(storyChapterSchema).default([]),
});

export type Story = z.infer<typeof storySchema>;
export type StoryChapter = z.infer<typeof storyChapterSchema>;
export type StoryBlock = z.infer<typeof storyBlockSchema>;

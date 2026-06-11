import { z } from "zod/v4";

const storyFileSchema = z.object({
  path: z.string().default(""),
  role: z.string().default(""),
  narrative: z.string().default(""),
});

const storyChapterSchema = z.object({
  title: z.string().default(""),
  narrative: z.string().default(""),
  files: z.array(storyFileSchema).default([]),
});

export const storySchema = z.object({
  headline: z.string().default(""),
  synopsis: z.string().default(""),
  chapters: z.array(storyChapterSchema).default([]),
});

export type Story = z.infer<typeof storySchema>;
export type StoryChapter = z.infer<typeof storyChapterSchema>;

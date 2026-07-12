import { z } from "zod/v4";

// Permissive on purpose: agent output is validated loosely here so partial
// output still parses; normalizeQuiz enforces the real invariants (2..5
// options, in-range correctIndex, known paths, at most 6 questions).
const quizQuestionSchema = z.object({
  question: z.string().max(4_000).default(""),
  options: z.array(z.string().max(2_000)).max(20).default([]),
  correctIndex: z.number().int().default(0),
  explanation: z.string().max(8_000).default(""),
  path: z.string().max(1_024).default(""),
});

const quizImpactSchema = z.object({
  level: z.enum(["low", "moderate", "high", "critical"]).default("low"),
  reasons: z
    .array(
      z.object({
        signal: z.string().max(2_000).default(""),
        path: z.string().max(1_024).default(""),
      }),
    )
    .max(100)
    .default([]),
});

export const quizSchema = z.object({
  impact: quizImpactSchema.default({ level: "low", reasons: [] }),
  questions: z.array(quizQuestionSchema).max(50).default([]),
});

export type Quiz = z.infer<typeof quizSchema>;
export type QuizQuestion = z.infer<typeof quizQuestionSchema>;
export type QuizImpact = z.infer<typeof quizImpactSchema>;

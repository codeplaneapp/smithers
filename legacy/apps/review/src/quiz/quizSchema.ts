import { z } from "zod/v4";

// Permissive on purpose: agent output is validated loosely here so partial
// output still parses; normalizeQuiz enforces the real invariants (2..5
// options, in-range correctIndex, known paths, at most 6 questions).
const quizQuestionSchema = z.object({
  question: z.string().default(""),
  options: z.array(z.string()).default([]),
  correctIndex: z.number().int().default(0),
  explanation: z.string().default(""),
  path: z.string().default(""),
});

const quizImpactSchema = z.object({
  level: z.enum(["low", "moderate", "high", "critical"]).default("low"),
  reasons: z
    .array(
      z.object({
        signal: z.string().default(""),
        path: z.string().default(""),
      }),
    )
    .default([]),
});

export const quizSchema = z.object({
  impact: quizImpactSchema.default({ level: "low", reasons: [] }),
  questions: z.array(quizQuestionSchema).default([]),
});

export type Quiz = z.infer<typeof quizSchema>;
export type QuizQuestion = z.infer<typeof quizQuestionSchema>;
export type QuizImpact = z.infer<typeof quizImpactSchema>;

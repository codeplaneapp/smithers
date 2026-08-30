/**
 * The comprehension quiz a review can attach to its walkthrough.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema";
import { arrayOf, withDefault } from "../schema/withDefault.ts";

/**
 * One multiple-choice question.
 *
 * Permissive on purpose: agent output decodes loosely here so a partial answer
 * survives, and `normalizeQuiz` enforces the real invariants (2..5 options, an
 * in-range `correctIndex`, known paths, at most 6 questions).
 *
 * @since 1.0.0
 * @category schemas
 */
export const QuizQuestion = Schema.Struct({
  question: withDefault(Schema.String, ""),
  options: arrayOf(Schema.String),
  correctIndex: withDefault(Schema.Number, 0),
  explanation: withDefault(Schema.String, ""),
  path: withDefault(Schema.String, ""),
});

/**
 * A decoded question.
 *
 * @since 1.0.0
 * @category models
 */
export type QuizQuestion = typeof QuizQuestion.Type;

/**
 * How much the change moves, and the signals that say so.
 *
 * @since 1.0.0
 * @category schemas
 */
export const QuizImpact = Schema.Struct({
  level: withDefault(Schema.Literals(["low", "moderate", "high", "critical"]), "low" as const),
  reasons: arrayOf(
    Schema.Struct({
      signal: withDefault(Schema.String, ""),
      path: withDefault(Schema.String, ""),
    }),
  ),
});

/**
 * A decoded impact assessment.
 *
 * @since 1.0.0
 * @category models
 */
export type QuizImpact = typeof QuizImpact.Type;

/**
 * The quiz a narrator seat produces.
 *
 * @since 1.0.0
 * @category schemas
 */
export const Quiz = Schema.Struct({
  impact: withDefault(QuizImpact, { level: "low" as const, reasons: [] }),
  questions: arrayOf(QuizQuestion),
});

/**
 * A decoded quiz.
 *
 * @since 1.0.0
 * @category models
 */
export type Quiz = typeof Quiz.Type;

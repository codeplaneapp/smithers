import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Quiz, type QuizQuestion } from "./quizSchema.ts";

const decodeQuiz = Schema.decodeUnknownOption(Quiz);

// Exact normalized-key dedupe only: lowercase, strip accents, drop everything
// but ascii alphanumerics. A shared-prefix "near identical" heuristic falsely
// merged distinct questions ("…when X is null?" vs "…when X is null after
// retry?"), so extra words must always make a question distinct.
function normalizedTextKey(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const maxQuestions = 6;

// Adversarially robust: agents return garbage; keep only questions that are
// fully answerable (2..5 non-empty options, in-range correctIndex, a real
// question and explanation, a path from this change), dedupe near-identical
// questions, clamp to 6, and return null when nothing valid survives.
export function normalizeQuiz(raw: unknown, changedPaths: string[]): Quiz | null {
  const parsed = decodeQuiz(raw);
  if (Option.isNone(parsed)) return null;
  const knownPaths = new Set(changedPaths);
  const seenKeys = new Set<string>();
  const valid: QuizQuestion[] = [];
  for (const question of parsed.value.questions) {
    const text = question.question.trim();
    const explanation = question.explanation.trim();
    const options = question.options.map((option) => option.trim());
    const path = question.path.trim();
    if (!text || !explanation) continue;
    if (options.length < 2 || options.length > 5) continue;
    if (options.some((option) => !option)) continue;
    if (question.correctIndex < 0 || question.correctIndex >= options.length) continue;
    if (path && !knownPaths.has(path)) continue;
    // An empty key (e.g. CJK text with no ascii alphanumerics) carries no
    // dedupe signal; never treat two such questions as duplicates.
    const key = normalizedTextKey(text);
    if (key) {
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
    }
    valid.push({ question: text, options, correctIndex: question.correctIndex, explanation, path });
    if (valid.length === maxQuestions) break;
  }
  if (valid.length === 0) return null;
  return { impact: parsed.value.impact, questions: valid };
}

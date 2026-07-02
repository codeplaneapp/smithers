import { quizSchema, type Quiz, type QuizQuestion } from "./quizSchema";

function normalizedTextKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function nearIdenticalText(a: string, b: string) {
  const keyA = normalizedTextKey(a);
  const keyB = normalizedTextKey(b);
  if (keyA === keyB) return true;
  const shorter = Math.min(keyA.length, keyB.length);
  if (shorter === 0) return false;
  let shared = 0;
  while (shared < shorter && keyA[shared] === keyB[shared]) shared += 1;
  return shared / shorter >= 0.9;
}

const maxQuestions = 6;

// Adversarially robust: agents return garbage; keep only questions that are
// fully answerable (2..5 non-empty options, in-range correctIndex, a real
// question and explanation, a path from this change), dedupe near-identical
// questions, clamp to 6, and return null when nothing valid survives.
export function normalizeQuiz(raw: unknown, changedPaths: string[]): Quiz | null {
  const parsed = quizSchema.safeParse(raw);
  if (!parsed.success) return null;
  const knownPaths = new Set(changedPaths);
  const valid: QuizQuestion[] = [];
  for (const question of parsed.data.questions) {
    const text = question.question.trim();
    const explanation = question.explanation.trim();
    const options = question.options.map((option) => option.trim());
    const path = question.path.trim();
    if (!text || !explanation) continue;
    if (options.length < 2 || options.length > 5) continue;
    if (options.some((option) => !option)) continue;
    if (question.correctIndex < 0 || question.correctIndex >= options.length) continue;
    if (path && !knownPaths.has(path)) continue;
    if (valid.some((existing) => nearIdenticalText(existing.question, text))) continue;
    valid.push({ question: text, options, correctIndex: question.correctIndex, explanation, path });
    if (valid.length === maxQuestions) break;
  }
  if (valid.length === 0) return null;
  return { impact: parsed.data.impact, questions: valid };
}

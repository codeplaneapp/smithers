import type { Quiz } from "../quiz/quizSchema.ts";
import { escapeHtml } from "./escapeHtml.ts";
import { pluralize } from "../text/pluralize.ts";

const optionKeys = ["A", "B", "C", "D", "E"];

/**
 * The reviewer quiz: an impact banner (level + reasons) followed by
 * interactive multiple-choice questions. All behavior lives in the shared
 * inline page script (see walkthroughScript); this renders the markup with
 * the answer key in data attributes, plus a noscript fallback that reveals
 * each answer through a plain <details>. Returns "" when there is nothing to
 * quiz so the section costs nothing on quiet changes.
 */
export function renderQuizSection(quiz: Quiz | null | undefined, anchorByPath: Map<string, string>): string {
  if (!quiz || quiz.questions.length === 0) return "";

  const reasons =
    quiz.impact.reasons.length > 0
      ? `<ul class="impact-reasons">${quiz.impact.reasons
          .map(
            (reason) =>
              `<li>${escapeHtml(reason.signal)}${reason.path ? ` — <code>${escapeHtml(reason.path)}</code>` : ""}</li>`,
          )
          .join("")}</ul>`
      : "";
  const banner = [
    `<div class="impact-banner impact-${escapeHtml(quiz.impact.level)}">`,
    `<span class="impact-level">${escapeHtml(quiz.impact.level)} impact</span>`,
    `<span class="impact-note">Check you read the risky parts before signing off.</span>`,
    reasons,
    `</div>`,
  ].join("");

  const questions = quiz.questions
    .map((question, index) => {
      const anchor = anchorByPath.get(question.path);
      const jump = anchor
        ? ` <a class="jump" href="#${anchor}" data-jump>jump to <code>${escapeHtml(question.path)}</code></a>`
        : "";
      const options = question.options
        .map(
          (option, optionIndex) =>
            `<button type="button" class="quiz-option" data-option="${optionIndex}" aria-pressed="false"><span class="opt-key">${optionKeys[optionIndex] ?? optionIndex + 1}</span><span>${escapeHtml(option)}</span></button>`,
        )
        .join("");
      const answerText = question.options[question.correctIndex] ?? "";
      return [
        `<div class="quiz-question" data-correct="${question.correctIndex}" data-path="${escapeHtml(question.path)}" id="quiz-q${index + 1}">`,
        `<p class="q-text" id="quiz-q${index + 1}-label"><span class="q-num">${index + 1}.</span>${escapeHtml(question.question)}</p>`,
        `<div class="quiz-options" role="group" aria-labelledby="quiz-q${index + 1}-label">${options}</div>`,
        `<p class="quiz-verdict" aria-live="polite" hidden></p>`,
        `<p class="quiz-expl" hidden>${escapeHtml(question.explanation)}${jump}</p>`,
        `<noscript><details class="quiz-answer-fallback"><summary>Show answer</summary><p><strong>${escapeHtml(optionKeys[question.correctIndex] ?? String(question.correctIndex + 1))}.</strong> ${escapeHtml(answerText)}</p><p>${escapeHtml(question.explanation)}</p></details></noscript>`,
        `</div>`,
      ].join("");
    })
    .join("");

  return [
    `<section class="panel" id="quiz" data-spy data-spy-label="Reviewer quiz">`,
    `<h2>Reviewer quiz<span class="count-pill">${pluralize(quiz.questions.length, "question")}</span><span class="quiz-score" role="status" data-quiz-score hidden></span></h2>`,
    banner,
    questions,
    `<div class="quiz-summary" data-quiz-summary aria-live="polite" hidden><span data-quiz-summary-text></span><button type="button" class="quiz-attest" data-quiz-attest>Copy attestation</button><button type="button" class="quiz-retake" data-quiz-retake>Retake quiz</button></div>`,
    `</section>`,
  ].join("");
}

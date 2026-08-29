# quiz/

Reviewer comprehension quiz for high-impact changes.

- `assessChangeImpact.ts` — scores the change from path/content/finding
  signals (thresholds documented at `levelForScore`).
- `shouldAutoQuiz.ts` — gates auto mode to high/critical impact.
- `buildQuizPrompt.ts` — writes the quiz-author agent prompt.
- `quizSchema.ts` — deliberately permissive decode of the seat's answer;
  `normalizeQuiz.ts` enforces the real invariants (2-5 options, in-range
  correctIndex, known file paths, at most 6 questions, exact-key dedupe).

`QuizChanges` runs in the narrating round beside `NarrateChanges`, so
`buildQuizPrompt`'s optional `story` argument is unused in production (only
tests exercise that branch).

Rendering lives elsewhere: `walkthrough/renderQuizSection.ts` for the HTML
walkthrough and `github/buildPullRequestReview.ts` (`quizSection`) for the PR
body.

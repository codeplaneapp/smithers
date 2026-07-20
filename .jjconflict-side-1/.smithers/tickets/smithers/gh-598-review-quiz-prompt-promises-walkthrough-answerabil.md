# 🧹 review: quiz prompt promises walkthrough-answerability but the quiz task never receives the story

GitHub: https://github.com/smithersai/smithers/issues/598

**What happens**
`apps/review/src/quiz/buildQuizPrompt.ts:43` tells the quiz-writing agent "Every question must be answerable from the walkthrough and diffs alone", and the builder supports an optional `story` argument (`buildQuizPrompt.ts:9`, rendered at line 68). The only production call site, `apps/review/src/workflow/createReviewWorkflow.tsx:295-300`, never passes `story`, and the quiz task's `dependsOn` (line 289) is `collect-changes`/`review`/`final-review` — not `narrate` — so the story cannot exist when the quiz prompt is built. Only tests exercise the story branch.

**Why it matters**
The quiz writer is told to anchor questions in a walkthrough it never sees; the instruction is unenforceable and mildly misleading. Meanwhile the human quiz-taker *does* see the walkthrough, so story-informed questions would be strictly better.

**Options**
1. Make `quiz` depend on `narrate` and pass the normalized story (costs parallelism — quiz then serializes behind narrate).
2. Keep the parallelism and reword the prompt line to "answerable from the diffs alone".

Either is fine; today's state is the worst of both.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).

# Cut get-started by ~75–80%: 1–3 steps, stop bombarding with choices

Filed from user feedback on X (onboarding replies), 2026-06-17.

## Problem

*"the onboarding should be cut by 75%"* / *"cut 80% of the content or
move/deprioritize it"* / *"dont bombard me with choices."* The get-started page
has paragraphs of explanation and multiple choices up front, which is a barrier
to a first run.

## Requirement

- Reduce get-started to **1–3 steps** with no upfront branching choices.
- Move the deep explanations (concepts, alternatives, configuration) to later
  pages users reach AFTER a successful first run.
- (Recent work: commit *"cut onboarding to one command"* — verify the live page
  meets the 1–3-step / no-choices bar.)

## Acceptance

- get-started is ≤3 steps, single happy path, no decision points before the first
  successful run; everything else is linked, not inlined.

Related: [0043](0043-one-command-helloworld-mdx-default.md),
[0044](0044-default-to-mdx-deprioritize-sdk.md).

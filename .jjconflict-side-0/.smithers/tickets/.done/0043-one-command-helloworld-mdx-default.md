# Default first-run = 1 command + an editable hello-world .mdx template

Filed from user feedback on X (onboarding replies), 2026-06-17.

## Problem

*"Just give me something like: 1 command + hello world .mdx template and thats
it? afterwards I can start learning about the other stuff. Maybe put it on the
front page even."* The canonical first experience should be a single command
that scaffolds an editable hello-world workflow as MDX, with nothing else
required.

## Requirement

- One command scaffolds an editable hello-world workflow (`.mdx`) the user can
  run immediately.
- Consider featuring this one-command path on the docs front page / landing.
- (Recent work: commit *"seed an editable hello-world workflow"* on init —
  verify it produces an **MDX** hello-world and is the headline of get-started.)

## Acceptance

- A new user runs one command, gets a hello-world `.mdx`, and runs it — before
  reading anything else.

Related: [0042](0042-cut-onboarding-volume.md),
[0044](0044-default-to-mdx-deprioritize-sdk.md).

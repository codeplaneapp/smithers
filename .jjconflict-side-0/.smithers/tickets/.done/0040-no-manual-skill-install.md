# Onboarding must not require hand-installing skills (mkdir + curl)

Filed from user feedback on X (onboarding replies), 2026-06-17.

## Problem

Onboarding presented manual steps like:

```
mkdir -p ~/.claude/skills/smithers
curl -fsSL ....llms-full.txt
curl -fsSL ....
```

to install the skill. Users should not be asked to do this by hand — *"please
dont make me do this kind of stuff"*. Running `smithers-orchestrator skills` is
supposed to perform the install; the docs/output should state that **it does it
for you**, not hand the user the raw mkdir/curl.

## Requirement

- `smithers-orchestrator skills` installs the curated skill(s) into the correct
  per-tool location automatically.
- Remove the manual mkdir/curl recipe from get-started; replace with the single
  command.
- (Recent work: commit *"auto-install curated smithers skill on init"* —
  verify it covers this path and that no manual recipe remains in docs/output.)

## Acceptance

- No get-started/docs path instructs a user to `mkdir`/`curl` skill files by hand.
- A fresh user gets skills installed by one command (or automatically on `init`).

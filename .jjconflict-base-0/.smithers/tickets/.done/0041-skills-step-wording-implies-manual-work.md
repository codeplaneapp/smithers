# Skills messaging reads as an extra manual step; don't mix it into "Get started"

Filed from user feedback on X (onboarding replies), 2026-06-17.

## Problem

Even when the skill install is explained, the wording gives *"the false
impression that it's an extra step, before they've actually read the content"*,
and it's mixed into the get-started flow. The intent is for the CLI to **tell**
the user "this is what's happening when you run `smithers-orchestrator skills`,"
not to read as a task the user must perform — *"it's supposed to tell you that's
what's happening … not ask you to do it yourself."*

## Requirement

- Reword the skills step so it clearly communicates the command does the work
  automatically (status/affordance, not a chore).
- Keep this messaging out of the core "Get started" steps so it does not inflate
  the perceived step count; surface it as informational output of the command.

## Acceptance

- The get-started step count does not grow because of skills; the skills behavior
  is communicated by the command output, phrased as "doing X for you."

Related: [0040](0040-no-manual-skill-install.md), [0042](0042-cut-onboarding-volume.md).

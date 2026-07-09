import { EXAMPLE_PROMPT } from "@/lib/landing/constants";
import type { JustSayPrompt } from "@/lib/landing/types";

export const JUST_SAY_SECTION = {
  label: "Just say this",
  title: "Built-in recipes for everyday agent work.",
  description:
    "Smithers ships dozens of powerful recipes — debug, audit, implement, triage, and more. Say what you want in chat; your coding agent picks and runs the right one. You never need to name the recipe.",
  examplesLabel: "Say it like this",
  examplesHint: "Expand an example to see what runs underneath — your agent chooses the recipe.",
  marqueeLabel: "Built-in recipes · click to open on GitHub",
} as const;

export const JUST_SAY_PROMPTS: JustSayPrompt[] = [
  {
    id: "migrate-dashboard",
    prompt: EXAMPLE_PROMPT,
    recipe: "mission",
    recipeSummary:
      "Milestone plan, your approval, then focused workers per milestone.",
    steps: [
      { label: "Break down milestones", detail: "scope · breakdown", status: "pending" },
      { label: "Approval gate", detail: "wait for you", status: "waiting" },
      { label: "Milestone worker", detail: "execute · validate", status: "pending" },
      { label: "Next milestone", detail: "↻ until done", status: "running" },
    ],
  },
  {
    id: "rate-limiting",
    prompt:
      "Add rate limiting — don't stop until tests pass and a reviewer signs off.",
    recipe: "implement",
    recipeSummary: "Write the change, validate, review — loop until the reviewer signs off.",
    steps: [
      { label: "Write change", detail: "code the fix", status: "pending" },
      { label: "Validate", detail: "build · test", status: "pending" },
      { label: "Sign-off", detail: "reviewer agent", status: "pending" },
      { label: "Review loop", detail: "↻ until approved", status: "running" },
    ],
  },
];

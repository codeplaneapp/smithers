import { EXAMPLE_PROMPT } from "@/lib/landing/constants";

/** Canvas font strings aligned with landing CSS (`text-xs` mono, etc.) */
export const LANDING_FONTS = {
  monoXs: '400 12px "JetBrains Mono", ui-monospace, monospace',
  mono2xs: '400 10px "JetBrains Mono", ui-monospace, monospace',
} as const;

export const STEP_DETAIL_CANDIDATES = [
  "This needs to improve",
  "↻ back to plan",
  "click to approve",
  "in progress",
  "iter 2",
  "passed",
  "saved",
  "approved",
] as const;

/** Worst-case copy used to reserve block height via Pretext. */
export const CHAT_USER_RESERVE = EXAMPLE_PROMPT;

export const CHAT_AGENTS_RESERVE = [
  "Starting the implement recipe in Smithers…",
  "Review passed — applying the change.",
].join("\n\n");

export const STEPS_PANEL_RESERVE = [
  "Milestones approved",
  "Milestone 1 — audit routes",
  "Milestone 2 — swap client",
  "Milestone 3 — e2e tests",
  "Waiting for your OK on milestones",
  "Agent working milestone 1 — each step saves as it completes",
].join("\n");

export const RUN_FOOTER_RESERVE = "Review gate passed — run continues";

export const LOOP_HEADER_RESERVE =
  "plan · review loop · iter 2 · gate passed";

/** Full talk-tab demo shell — chat + steps at max state. */
export const TALK_SHELL_RESERVE = [
  CHAT_USER_RESERVE,
  CHAT_AGENTS_RESERVE,
  STEPS_PANEL_RESERVE,
].join("\n\n");

/** Full run-tab demo shell — steps + loop + footer at max state. */
export const RUN_SHELL_RESERVE = [
  "Scope",
  LOOP_HEADER_RESERVE,
  "Plan",
  "Review",
  "This needs to improve",
  "Ship",
  RUN_FOOTER_RESERVE,
].join("\n");

export const LINE_HEIGHT = {
  monoXs: 20,
  mono2xs: 16,
} as const;

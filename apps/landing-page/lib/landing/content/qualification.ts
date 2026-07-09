import type { QualificationUseCase } from "@/lib/landing/types";

export const QUALIFICATION_USE_CASES: QualificationUseCase[] = [
  {
    id: "multi-step",
    title: "Multi-step jobs",
    text: "Ask your agent to chain steps in order — not one monolithic chat thread",
    visual: "multi-step",
  },
  {
    id: "durable",
    title: "Crash-safe work",
    text: "Need work to survive crash, sleep, or flaky tools",
    visual: "durable",
  },
  {
    id: "approval",
    title: "Approve before ship",
    text: "Want to approve before ship and walk away for hours",
    visual: "approval",
  },
  {
    id: "long-run",
    title: "Hours or days",
    text: "Run jobs for hours or days, not one prompt",
    visual: "long-run",
  },
];

export const QUALIFICATION_SKIP = {
  label: "Skip when",
  heading: "Don't use Smithers if you work like this",
  title: "One prompt, one answer",
  text: "Use Claude, Codex, or your model SDK directly — no orchestration layer needed.",
} as const;

export const QUALIFICATION_BRIDGE =
  "Smithers adds structure and persistence underneath the agent you already use.";

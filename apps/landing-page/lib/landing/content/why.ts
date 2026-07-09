import type { WhyDemoType } from "@/lib/landing/types";

export const WHY_SECTION = {
  description:
    "Chat is one context and one shot. Smithers lets you design context per step and feedback loops that rerun until the work is right.",
} as const;

export const WHY_CARDS: {
  title: string;
  body: string;
  demo: WhyDemoType;
}[] = [
  {
    title: "Multi-agent systems improve quality",
    body: "Scope what each step sees — not one bloated thread. Wire review loops that check output and send the agent back until it passes. Quality comes from the system you designed.",
    demo: "multi-agent",
  },
  {
    title: "Your expertise, built in",
    body: "Embed domain rules, checks, and standards in the workflow. The agent follows your playbook — you don't steer it by hand every run.",
    demo: "expertise",
  },
  {
    title: "Improve the system",
    body: "When output is wrong, tighten the recipe — not rewrite the answer in chat. Each iteration makes the orchestration better.",
    demo: "system",
  },
];

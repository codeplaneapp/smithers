import { LINKS } from "@/lib/landing/constants";
import type { DocLinkCard } from "@/lib/landing/types";

export const GET_STARTED = {
  title: "One command. Then talk to your agent.",
  description:
    "Run init once. You get a hello workflow you can run immediately — and your coding agent learns how to drive Smithers for you. No workflow syntax first.",
  commandLabel: "Run this in your project",
  commandPayoff:
    "Creates an editable hello.mdx workflow you can run immediately, then installs the smithers skill into your agents.",
  firstPrompt: "Run the hello workflow",
  firstPromptHint: "Or say any outcome from above — your agent picks the recipe.",
  closer: "Your workflows survive. Your laptop doesn't have to.",
} as const;

export const GET_STARTED_STEPS = [
  {
    n: 1,
    title: "Init in your repo",
    detail: "hello.mdx, Smithers config, and the smithers skill — ready in one command.",
  },
  {
    n: 2,
    title: "Tell your agent",
    detail: "Same chat you use today. Ask for an outcome — not orchestration syntax.",
  },
  {
    n: 3,
    title: "Walk away",
    detail: "Steps save as they finish. Crash, sleep, or flaky tools — resume from the last save.",
  },
] as const;

export const DOC_LINK_CARDS: DocLinkCard[] = [
  {
    title: "Start in chat",
    description:
      "Run one command, phrase outcomes, let your agent drive. Learn Smithers without writing a workflow by hand.",
    href: LINKS.getStarted,
    cta: "Read the guide",
    recommended: true,
  },
  {
    title: "Docs for your coding agent",
    description:
      "Full API, components, and patterns for the harness that authors and runs workflows. Or feed /llms-full.txt.",
    href: LINKS.agentDocs,
    cta: "Read the agent docs",
  },
];

export const FOOTER_LINKS = [
  { label: "Documentation", href: LINKS.docs },
  { label: "Get started", href: LINKS.getStarted },
  { label: "Agent introduction", href: LINKS.agentDocs },
  { label: "GitHub", href: LINKS.github },
  { label: "llms-full.txt", href: LINKS.llmsTxt },
] as const;

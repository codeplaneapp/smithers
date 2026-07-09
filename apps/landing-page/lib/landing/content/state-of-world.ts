import { LINKS } from "@/lib/landing/constants";
import type { StateLayer, StateQuote } from "@/lib/landing/types";

export const STATE_QUOTES: StateQuote[] = [
  {
    kind: "tweet",
    href: LINKS.steipeteTweet,
    authorName: "Peter Steinberger",
    authorHandle: "steipete",
    authorAvatar: "https://unavatar.io/x/steipete",
    text: "Here's your monthly reminder that you shouldn't be prompting coding agents anymore. You should be designing loops that prompt your agents.",
    postedAt: "Jun 7, 2026",
    stats: {
      replies: "1.8K",
      reposts: "1.4K",
      likes: "20K",
      views: "8.4M",
    },
  },
  {
    kind: "quote",
    text: "Design systems that prompt, check, and repeat — not one-shot answers.",
    author: "Industry shift",
  },
];

export const STATE_LAYERS_HEADLINE = "One layer doesn't change.";

export const STATE_LAYERS_PULL_QUOTE =
  "The right way to build an agent changes every six months.";

export const STATE_LAYERS_LEDE =
  "Models, topologies, and playbooks rotate on different clocks. Durable orchestration doesn't — Smithers is that layer.";

export const STATE_LAYERS_SHIFT_LABEL = "Keeps changing";
export const STATE_LAYERS_STABLE_LABEL = "Stays";

export const STATE_LAYERS: StateLayer[] = [
  {
    label: "Model",
    examples: "Claude, GPT, Gemini, Kimi",
    cadence: "Volatile · weekly",
    unstable: true,
  },
  {
    label: "Topology",
    examples: "ReAct, crew, swarm, background agents",
    cadence: "Fluid · monthly",
    unstable: true,
  },
  {
    label: "How you build",
    examples: "Prompting → loops → skills → recipes",
    cadence: "Shifts · every six months",
    unstable: true,
  },
  {
    label: "Orchestration",
    tagline: "this is Smithers",
    examples: "Durable steps, retries, state, approvals, observability",
    cadence: "Stable · doesn't change",
    unstable: false,
  },
];

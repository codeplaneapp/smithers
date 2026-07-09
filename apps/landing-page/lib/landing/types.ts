export type StepStatus =
  | "pending"
  | "running"
  | "saved"
  | "waiting"
  | "skipped"
  | "retry";

export type StepRowData = {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
};

export type WhyDemoType = "multi-agent" | "expertise" | "system";

export type QualificationVisualType =
  | "multi-step"
  | "durable"
  | "approval"
  | "long-run"
  | "single-shot";

export type QualificationUseCase = {
  id: string;
  title: string;
  text: string;
  visual: QualificationVisualType;
};

export type FlowNode = {
  label: string;
  detail: string;
  caption?: string;
  highlight?: boolean;
};

export type HeroTabId = "talk" | "run";

export type TweetPost = {
  kind: "tweet";
  href: string;
  authorName: string;
  authorHandle: string;
  authorAvatar: string;
  text: string;
  postedAt: string;
  stats: {
    replies: string;
    reposts: string;
    likes: string;
    views: string;
  };
};

export type PullQuote = {
  kind: "quote";
  text: string;
  author: string;
  href?: string;
};

export type StateQuote = TweetPost | PullQuote;

export type StateLayer = {
  label: string;
  tagline?: string;
  examples: string;
  cadence: string;
  unstable: boolean;
};

export type RecipeStep = {
  label: string;
  detail?: string;
  status?: StepStatus;
};

export type JustSayPrompt = {
  id: string;
  prompt: string;
  recipe: string;
  recipeSummary: string;
  steps: RecipeStep[];
};

export type DocLinkCard = {
  title: string;
  description: string;
  href: string;
  cta: string;
  recommended?: boolean;
};

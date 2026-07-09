export const RUN_ID = "implement · a8f2c1";
export const RUN_ID_SHORT = "a8f2c1";

export const EXAMPLE_PROMPT =
  "Migrate the dashboard to the new gateway APIs. Show me the plan before you start.";

export const EXAMPLE_PROMPTS = [
  EXAMPLE_PROMPT,
  "Add rate limiting — don't stop until tests pass and a reviewer signs off.",
] as const;

export const INIT_COMMAND = "bunx smithers-orchestrator init";

export const LINKS = {
  docs: "https://smithers.sh",
  getStarted: "https://smithers.sh/guide/get-started",
  agentDocs: "https://smithers.sh/introduction",
  github: "https://github.com/smithersai/smithers",
  llmsTxt: "https://smithers.sh/llms-full.txt",
  workflows: "https://smithers.sh/guide/what-you-can-do",
  steipeteTweet: "https://x.com/steipete/status/2063697162748260627",
} as const;

export const HARNESSES = [
  "Codex",
  "Claude Code",
  "Cursor",
  "Gemini",
  "Pi",
] as const;

export type { StepRowData, StepStatus } from "@/lib/landing/types";

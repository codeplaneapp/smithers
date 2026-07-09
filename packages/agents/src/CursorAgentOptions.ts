import type { BaseCliAgentOptions } from "./BaseCliAgent/BaseCliAgentOptions";

export type CursorAgentOptions = BaseCliAgentOptions & {
  apiKey?: string;
  header?: string[];
  model?: string;
  mode?: "plan" | "ask";
  plan?: boolean;
  resume?: string | boolean;
  continueSession?: boolean;
  force?: boolean;
  autoReview?: boolean;
  sandbox?: "enabled" | "disabled";
  approveMcps?: boolean;
  trust?: boolean;
  workspace?: string;
  pluginDir?: string[];
  worktree?: string | boolean;
  worktreeBase?: string;
  skipWorktreeSetup?: boolean;
  streamPartialOutput?: boolean;
};

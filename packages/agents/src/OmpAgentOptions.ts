import type { BaseCliAgentOptions } from "./BaseCliAgent/BaseCliAgentOptions";

export type OmpAgentOptions = BaseCliAgentOptions & {
  provider?: string;
  model?: string;
  apiKey?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  mode?: "text" | "json" | "rpc";
  print?: boolean;
  continueSession?: boolean;
  resume?: string;
  sessionDir?: string;
  noSession?: boolean;
  tools?: string[];
  noTools?: boolean;
  extensions?: string[];
  noExtensions?: boolean;
  skills?: string[];
  noSkills?: boolean;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  hideThinking?: boolean;
  printThoughts?: boolean;
  hooks?: string[];
  maxTime?: number | string;
  autoApprove?: boolean;
  approvalMode?: string;
};

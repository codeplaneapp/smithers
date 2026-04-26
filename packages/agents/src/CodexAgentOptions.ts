import type { BaseCliAgentOptions } from "./BaseCliAgent/BaseCliAgentOptions";
import type { CodexConfigOverrides } from "./BaseCliAgent/CodexConfigOverrides";

export type CodexAgentOptions = BaseCliAgentOptions & {
  config?: CodexConfigOverrides;
  enable?: string[];
  disable?: string[];
  image?: string[];
  model?: string;
  oss?: boolean;
  localProvider?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  profile?: string;
  fullAuto?: boolean;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  cd?: string;
  skipGitRepoCheck?: boolean;
  addDir?: string[];
  outputSchema?: string;
  color?: "always" | "never" | "auto";
  json?: boolean;
  outputLastMessage?: string;
  /**
   * Path to an isolated Codex CLI config directory. Sets `CODEX_HOME` on the
   * spawned process so this invocation uses the credentials stored at
   * `<configDir>/auth.json` (instead of the user's default `~/.codex/`).
   *
   * Use this to run multiple Codex / ChatGPT subscriptions side-by-side. Set
   * up the directory by running `CODEX_HOME=<path> codex login` once.
   */
  configDir?: string;
  /**
   * OpenAI API key for billing this invocation against the API instead of a
   * ChatGPT Plus/Pro subscription. Sets `OPENAI_API_KEY` on the spawned
   * process.
   */
  apiKey?: string;
};

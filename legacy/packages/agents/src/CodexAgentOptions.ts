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
  /** Emits `--sandbox workspace-write` (codex-cli removed the old `--full-auto` alias). */
  fullAuto?: boolean;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  cd?: string;
  skipGitRepoCheck?: boolean;
  addDir?: string[];
  outputSchema?: string;
  /**
   * Opt in to Codex's native structured output (`codex exec --output-schema`).
   *
   * Defaults to `false`. Native structured output makes the model emit only the
   * final JSON and refuse tool calls, so it BREAKS agentic tasks (read/edit/run) —
   * Codex returns `blocked` with no changes. Left off, Smithers treats Codex like
   * the other CLI engines: it prompt-injects the schema and extracts JSON from the
   * agent's final message, so tool use stays intact. Enable only for pure, tool-free
   * extraction tasks that need strict schema enforcement.
   */
  nativeStructuredOutput?: boolean;
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
   * Sets `OPENAI_API_KEY` on the spawned process. Codex CLI >= 0.144 ignores
   * that variable for auth/billing selection when subscription login is
   * present, so this option is effectively inert on current CLIs.
   */
  apiKey?: string;
};

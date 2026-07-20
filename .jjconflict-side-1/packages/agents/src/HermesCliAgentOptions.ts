import type { BaseCliAgentOptions } from "./BaseCliAgent/BaseCliAgentOptions";

/**
 * Options for {@link HermesCliAgent}.
 *
 * Drives the `hermes` binary (Nous Research's Hermes Agent CLI) in its headless
 * one-shot mode (`hermes -z "<prompt>"`). Distinct from {@link HermesAgent},
 * which talks to the Hermes *model* over an OpenAI-compatible HTTP API. Use this
 * when you want a workflow `<Task>` to delegate to the Hermes agent itself.
 */
export type HermesCliAgentOptions = BaseCliAgentOptions & {
  /**
   * Force a specific provider backend (e.g. `openrouter`, `anthropic`,
   * `deepseek`). Emitted as `--provider`.
   */
  provider?: string;
  /**
   * Resume the most recent session, or a named session when a string is given.
   * Emitted as `-c`/`--continue`. Overridden by a per-call `resumeSession`.
   */
  continueSession?: string | boolean;
};

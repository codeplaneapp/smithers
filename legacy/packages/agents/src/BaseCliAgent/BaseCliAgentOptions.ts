import type { CliRecoveryPolicy } from "./CliRecoveryPolicy";

export type BaseCliAgentOptions = {
  id?: string;
  model?: string;
  systemPrompt?: string;
  instructions?: string;
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Whether spawned CLI processes inherit `process.env` before applying the
   * agent, task-context, and command-specific environment layers.
   *
   * Defaults to `true` for backwards compatibility. Set to `false` when an
   * agent must receive only explicitly supplied environment variables.
   */
  inheritEnv?: boolean;
  yolo?: boolean;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxOutputBytes?: number;
  extraArgs?: string[];
  /** Called after a provider quota error is classified. */
  onQuotaExceeded?: (details: {
    agentId?: string;
    agentEngine?: string;
    agentModel?: string;
    quotaResetAtMs?: number;
    underlying?: string;
  }) => void;
  /**
   * First-class reasoning effort, shared across every CLI adapter so a workflow
   * can request it uniformly and the engine can persist/display it per attempt.
   *
   * The declared ladder is `low | medium | high | xhigh | max`; the `| string`
   * escape hatch keeps provider-specific values valid. Each adapter translates
   * the value onto its own knob (explicit adapter-specific config always wins):
   * - ClaudeCodeAgent → merged into `--settings` as `{ effortLevel }`.
   * - CodexAgent → `config.model_reasoning_effort` (Codex historically accepts
   *   only `minimal | low | medium | high`, `xhigh` on newer gpt-5-codex; it is
   *   a documented pass-through with that ceiling — `max` is not a Codex value).
   * - OpenCodeAgent → the provider-defined `--variant` string (OpenCode has no
   *   fixed effort ladder), else unsupported for that adapter.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | string;
  /**
   * Typed provider retry/recovery policy. When set, generate/stream wrap
   * each invocation in a recovery loop: a failed attempt is classified by
   * the policy, retried fresh before substantive activity or resumed on the
   * exact emitted CLI session after it, with quarantined callbacks, bounded
   * backoff under the combined caller/retry deadline, and caller
   * cancellation honored throughout.
   */
  recoveryPolicy?: CliRecoveryPolicy;
};

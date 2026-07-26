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
};

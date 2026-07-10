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
};

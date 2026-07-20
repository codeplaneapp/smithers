import type { BaseCliAgentOptions } from "./BaseCliAgent/BaseCliAgentOptions";

export type KimiAgentOptions = BaseCliAgentOptions & {
  workDir?: string;
  session?: string;
  continue?: boolean;
  thinking?: boolean;
  outputFormat?: "text" | "stream-json";
  finalMessageOnly?: boolean;
  quiet?: boolean;
  agent?: "default" | "okabe";
  agentFile?: string;
  mcpConfigFile?: string[];
  mcpConfig?: string[];
  skillsDir?: string;
  maxStepsPerTurn?: number;
  maxRetriesPerStep?: number;
  maxRalphIterations?: number;
  verbose?: boolean;
  debug?: boolean;
  /**
   * Path to an isolated Kimi share directory. Sets `KIMI_SHARE_DIR` on the
   * spawned process so this invocation reads/writes credentials at
   * `<configDir>/credentials` (instead of the user's default `~/.kimi/`).
   * Equivalent to passing `env: { KIMI_SHARE_DIR: <path> }` but uniform with
   * the other agents' `configDir` option.
   */
  configDir?: string;
};

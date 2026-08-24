import type { BaseCliAgentOptions } from "./BaseCliAgent/BaseCliAgentOptions";

export type KimiAgentOptions = BaseCliAgentOptions & {
  /**
   * Target CLI dialect for argv construction. The default (undefined) builds
   * commands for the current Kimi CLI surface. `"0.29"` emits only flags the
   * `@moonshot-ai/kimi-code@0.29.x` commander surface accepts: `-p/--prompt`,
   * `--output-format`, `-m/--model`, `-y/--yolo`, `-c/--continue`,
   * `--add-dir` (repeated), `--skills-dir`, `--agent`, `--agent-file`, and a
   * caller-supplied `-S/--session`. Newer-only flags (`--print`,
   * `--final-message-only`, `--work-dir`, `--thinking`/`--no-thinking`, the
   * step/retry controls, the MCP config flags) are omitted, and Smithers never
   * forwards a synthetic `--session` in this dialect.
   */
  cliVersion?: "0.29";
  workDir?: string;
  session?: string;
  continue?: boolean;
  thinking?: boolean;
  /**
   * Additional workspace directories. Serialized as one `--add-dir <dir>`
   * pair per entry, which is what both the current CLI and the 0.29.x surface
   * accept.
   */
  addDir?: string[];
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

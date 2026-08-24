import type { BaseCliAgentOptions } from "./BaseCliAgent/BaseCliAgentOptions";

export type KimiWireUsageOptions = {
  /**
   * Explicit wire log path. Defaults to `wire.jsonl` in the invocation's
   * runtime home.
   */
  path?: string;
  /** Maximum bytes read from the log in one delta pass. Default 8 MiB. */
  maxBytes?: number;
  /** Maximum usage.record entries processed in one delta pass. Default 10000. */
  maxEntries?: number;
};

export type KimiSessionRecoverySource = "output" | "session-index";

export type KimiSessionRecoveryInfo = {
  /** The actual resumable session id resolved from the CLI. */
  sessionId: string;
  /** Where the id was resolved from. */
  source: KimiSessionRecoverySource;
  /** The invocation's runtime home. */
  homeDir?: string;
  /** The session's on-disk state directory inside the runtime home. */
  stateDir?: string;
};

export type KimiSessionRecoveryOptions = {
  /**
   * Called once when the actual resumable session id is resolved, either
   * from CLI output during the invocation or from the on-disk session index
   * at exit.
   */
  onSessionResolved?: (info: KimiSessionRecoveryInfo) => void | Promise<void>;
  /** Maximum total bytes copied for one session's state. Default 64 MiB. */
  maxBytes?: number;
  /** Maximum files copied for one session's state. Default 5000. */
  maxFiles?: number;
  /** Maximum directories visited while walking session state. Default 1000. */
  maxDirectories?: number;
};

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
   *
   * Note: the live child shares this directory. For parallel invocations
   * prefer `credentialDir`, which keeps credentials shared but read-only and
   * runs each invocation in an isolated runtime home.
   */
  configDir?: string;
  /**
   * Shared credential source directory, used read-only by the live child.
   * KimiAgent refreshes expired OAuth credentials here, then seeds an
   * isolated per-invocation runtime home (see `runtimeDir`) with the
   * credential files and points the child's `KIMI_SHARE_DIR` at that home.
   * Parallel invocations therefore share credentials without contending over
   * mutable session/config state. Mutually exclusive with `configDir`.
   */
  credentialDir?: string;
  /**
   * Explicit per-invocation runtime/session home. Defaults to a fresh temp
   * directory that is removed on cleanup; an explicit `runtimeDir` is
   * caller-owned and preserved.
   */
  runtimeDir?: string;
  /**
   * Durable, caller-managed session state store. With `sessionRecovery`
   * enabled, a resumed session's state is seeded from here into the isolated
   * invocation home before launch, and the invocation's resulting state is
   * copied back here at exit, so a later invocation can resume it.
   */
  sessionStateDir?: string;
  /**
   * Invocation-local usage extraction from the CLI's `wire.jsonl`
   * `usage.record` entries (cache-read, cache-write, other-input, and output
   * counters). The log position is baselined at invocation start, and
   * re-baselined after resumed session state is seeded, so historical tokens
   * are never re-billed. The delta is attached to the completed event as
   * normalized usage.
   */
  wireUsage?: boolean | KimiWireUsageOptions;
  /**
   * Actual-session recovery. Resolve and publish the real resumable session
   * id (from CLI output, or the on-disk session index at exit) instead of
   * the synthetic pre-launch id, and copy its on-disk state between the
   * isolated invocation home and `sessionStateDir` so resume works.
   */
  sessionRecovery?: boolean | KimiSessionRecoveryOptions;
};

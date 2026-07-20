import type { FleetTierModels } from "./FleetTierModels";

export type BuildFleetTiersOptions = {
  /** Per-tier Claude model ids. Defaults to `defaultFleetTierModels`. */
  models?: Partial<FleetTierModels>;
  /**
   * `CLAUDE_CODE_OAUTH_TOKEN` to pin these agents to one subscription. Omit to
   * inherit the container's env (the 1-container-per-subscription default).
   */
  token?: string;
  /** Isolated Claude config dir (alternative to `token`). */
  configDir?: string;
  /** Working directory for every agent (the benchmark checkout). */
  cwd?: string;
  /** Full-permission mode for unattended benchmark runs. Default true. */
  yolo?: boolean;
  /** Hard per-task timeout. Default 75 minutes (matches roadmapbench). */
  timeoutMs?: number;
  /** Idle timeout before a task is considered stuck. Default 12 minutes. */
  idleTimeoutMs?: number;
};

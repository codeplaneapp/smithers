import type React from "react";
import type { AgentLike } from "@smthrs/agents/AgentLike";
import type { MonitorCondition } from "./MonitorCondition.ts";
import type { OutputTarget } from "./OutputTarget.ts";

export type MonitorProps = {
  /** ID prefix for generated task/component ids. Default `"monitor"`. */
  id?: string;
  /** Run id this monitor watches. Usually `ctx.input.watchRunId`. */
  watchRunId: string;
  /** Workflow path used by shipped resume/retry commands. Defaults to `ctx.input.watchWorkflowPath`. */
  watchWorkflowPath?: string;
  /** Agent that samples the watched run and classifies its health. */
  agent: AgentLike | AgentLike[];
  /**
   * Output target for the heartbeat classification. The schema must carry at
   * least `condition` (a {@link MonitorCondition}) and `runStatus`;
   * `targetNodeId`, `evidence`, and `summary` are read when present. `nodeId`,
   * `runId`, and `iteration` are reserved output columns — hence `targetNodeId`.
   */
  healthOutput: OutputTarget;
  /** Output target handler tasks write to. Defaults to `healthOutput`. */
  actionOutput?: OutputTarget;
  /** Agent the healing/reporting handlers run on. Defaults to `agent`. */
  healAgent?: AgentLike | AgentLike[];
  /** Wall-clock delay between heartbeats, enforced by a durable `<Timer>`. Default 60000. */
  intervalMs?: number;
  /** Maximum heartbeats before the monitor stops watching. Default 120. */
  maxChecks?: number;
  /** Heartbeats with no progress before `stalled` is the expected verdict. Default 3. */
  stallBeats?: number;
  /**
   * Conditions the monitor may heal WITHOUT asking a human. Anything not listed
   * escalates instead. Default `["stalled", "wedged-node"]` — the two repairs
   * that are idempotent and reversible.
   */
  autoHeal?: MonitorCondition[];
  /**
   * Override the element rendered for a condition. `null` means "do nothing and
   * keep watching" for that condition; omit a key to keep the shipped default.
   */
  handlers?: Partial<Record<MonitorCondition, React.ReactElement | null>>;
  /** Extra repo-specific doctrine appended to the shipped monitoring prompt. */
  guidance?: string;
  /** Replace the shipped monitoring prompt entirely. Prefer `guidance` first. */
  prompt?: string | React.ReactNode;
  skipIf?: boolean;
  /** Alias for `prompt`. */
  children?: string | React.ReactNode;
};

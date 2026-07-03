import type { BaseCliAgentOptions } from "./BaseCliAgent/BaseCliAgentOptions";

/**
 * Options for {@link OpenClawAgent}.
 *
 * Drives the `openclaw` binary through the gateway-backed one-shot agent CLI:
 * `openclaw agent --agent <id> --message <prompt> --json`. Use this when a
 * workflow `<Task>` should delegate to OpenClaw itself.
 */
export type OpenClawAgentOptions = BaseCliAgentOptions & {
  /** OpenClaw agent id. Defaults to OpenClaw's configured default agent. */
  agent?: string;
  /** Session id to route the message into. Emits OpenClaw's `--session-id` flag. */
  sessionId?: string;
  /** Legacy alias for sessionId. */
  session?: string;
  /** Workspace/root directory to expose to OpenClaw, when supported by the installed CLI. */
  workspace?: string;
  /** Request JSON output from OpenClaw. Defaults to true. */
  json?: boolean;
  /** Continue an existing/default conversation, when supported by the installed CLI. */
  continueSession?: boolean;
};

import {
  AmpAgent,
  AntigravityAgent,
  ClaudeCodeAgent,
  CodexAgent,
  KimiAgent,
  OpenCodeAgent,
  PiAgent,
  type AgentLike,
} from "@smithers-orchestrator/agents";

type AgentFactory = (cwd: string) => AgentLike;

/**
 * Map a detected agent id to the real CLI agent class from
 * `@smithers-orchestrator/agents`. Each agent shells out to the locally
 * installed CLI (claude, codex, …) — this is the same runtime the engine drives
 * for production runs, not a chat-specific shim.
 */
const AGENT_FACTORIES: Record<string, AgentFactory> = {
  claude: (cwd) => new ClaudeCodeAgent({ cwd, yolo: true }) as unknown as AgentLike,
  codex: (cwd) => new CodexAgent({ cwd, yolo: true }) as unknown as AgentLike,
  opencode: (cwd) => new OpenCodeAgent({ cwd, yolo: true }) as unknown as AgentLike,
  antigravity: (cwd) => new AntigravityAgent({ cwd, yolo: true }) as unknown as AgentLike,
  pi: (cwd) => new PiAgent({ cwd, yolo: true }) as unknown as AgentLike,
  kimi: (cwd) => new KimiAgent({ cwd, yolo: true }) as unknown as AgentLike,
  amp: (cwd) => new AmpAgent({ cwd, yolo: true }) as unknown as AgentLike,
};

/**
 * Build the real agent runtime for a chat session, or throw when the requested
 * provider is not installed/usable. Never returns a stub.
 */
export function createChatAgent(agentId: string | null, cwd: string): AgentLike {
  if (!agentId) {
    throw new Error("No usable agent is installed for chat. Install an agent CLI (e.g. claude) and retry.");
  }
  const factory = AGENT_FACTORIES[agentId];
  if (!factory) {
    throw new Error(`Chat does not support agent provider "${agentId}".`);
  }
  return factory(cwd);
}

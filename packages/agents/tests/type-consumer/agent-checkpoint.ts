import {
  DEFAULT_AGENT_CHECKPOINT_MAX_BYTES,
  cloneAgentCheckpoint,
  type AgentCheckpoint,
  type AgentCheckpointCapability,
  type AgentCheckpointMode,
} from "@smthrs/agents/agent-checkpoint";
import type { AgentGenerateOptions } from "@smthrs/agents";

const checkpoint: AgentCheckpoint = {
  codec: "example/session",
  version: 1,
  payload: { cursor: 2 },
};
const mode: AgentCheckpointMode = "resume";
const capability: AgentCheckpointCapability = {
  codec: "example/session",
  versions: [1],
  modes: ["resume", "fork"],
};
const cloned: AgentCheckpoint = cloneAgentCheckpoint(checkpoint, DEFAULT_AGENT_CHECKPOINT_MAX_BYTES);
declare const generateOptions: AgentGenerateOptions;
const effectiveCheckpointLimit: number | undefined = generateOptions.maxAgentCheckpointBytes;
// @ts-expect-error checkpoint ceilings are byte counts
const invalidCheckpointLimit: AgentGenerateOptions = { maxAgentCheckpointBytes: "1024" };

void mode;
void capability;
void cloned;
void effectiveCheckpointLimit;
void invalidCheckpointLimit;

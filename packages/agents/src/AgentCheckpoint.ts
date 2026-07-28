export type AgentCheckpointJsonPrimitive = null | boolean | number | string;

export type AgentCheckpointJsonArray = AgentCheckpointJsonValue[];

export type AgentCheckpointJsonObject = {
  [key: string]: AgentCheckpointJsonValue;
};

/** A strict, recursively JSON-serializable value. */
export type AgentCheckpointJsonValue =
  | AgentCheckpointJsonPrimitive
  | AgentCheckpointJsonArray
  | AgentCheckpointJsonObject;

/**
 * Versioned state returned by an agent and supplied to a later generation.
 * Smithers validates and persists `payload` as JSON but never interprets it.
 */
export type AgentCheckpoint = {
  codec: string;
  version: number;
  payload: AgentCheckpointJsonValue;
};

/** Identifies why a saved checkpoint is being supplied to `generate()`. */
export type AgentCheckpointMode = "resume" | "fork";

/**
 * Declares one checkpoint format an agent can consume. Versions and modes are
 * exact; isolated fork support must always be explicit.
 */
export type AgentCheckpointCapability = {
  codec: string;
  versions: readonly number[];
  modes: readonly AgentCheckpointMode[];
};

/** Declares checkpoint formats an agent can produce. */
export type AgentCheckpointFormat = {
  codec: string;
  versions: readonly number[];
};

/**
 * A durability fence supplied to `generate()`. The agent must await the
 * returned promise before treating the checkpoint as published. Resolution
 * means the runtime durably stored the checkpoint while it still owned the
 * invocation; rejection means publication failed or ownership was lost.
 */
export type AgentCheckpointPublisher = (checkpoint: AgentCheckpoint) => Promise<void>;

/** Optional checkpoint extension carried by an agent generation result. */
export type AgentCheckpointResult = {
  checkpoint?: AgentCheckpoint;
};

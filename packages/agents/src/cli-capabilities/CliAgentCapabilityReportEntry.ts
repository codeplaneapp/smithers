import type { AgentCapabilityRegistry } from "../capability-registry";
import type { CliAgentSurfaceManifestEntry } from "../cli-surface/CliAgentSurfaceTypes";
import type { CliAgentCapabilityAdapterId } from "./CliAgentCapabilityAdapterId";

export type CliAgentCapabilityReportEntry = {
  id: CliAgentCapabilityAdapterId;
  binary: string;
  fingerprint: string;
  capabilities: AgentCapabilityRegistry;
  surface: CliAgentSurfaceManifestEntry;
};

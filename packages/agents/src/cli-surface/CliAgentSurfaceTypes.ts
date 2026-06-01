import type { CliAgentCapabilityAdapterId } from "../cli-capabilities/CliAgentCapabilityAdapterId";

export type CliAgentSurfaceOptionMapping = {
  option: string;
  flag?: string;
  env?: string;
  notes?: string;
};

export type CliAgentUnsupportedFlag = {
  flag: string;
  replacement?: string;
  reason: string;
};

export type CliAgentSurfaceResumeContract = {
  kind: "flag" | "subcommand" | "env" | "none";
  emitted: string[];
  notes: string;
};

export type CliAgentSurfaceManifestEntry = {
  id: CliAgentCapabilityAdapterId;
  displayName: string;
  binary: string;
  packageExport: string;
  defaultOutputFormat: "text" | "json" | "stream-json" | "rpc";
  docsUrls: string[];
  emittedFlags: string[];
  supportedFlags: string[];
  unsupportedFlags: CliAgentUnsupportedFlag[];
  optionMappings: CliAgentSurfaceOptionMapping[];
  resume: CliAgentSurfaceResumeContract;
};

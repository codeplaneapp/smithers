export type HijackCandidateConfig = {
  model?: string;
  yolo?: boolean;
  permissionMode?: string;
  dangerouslySkipPermissions?: boolean;
  configDir?: string;
};

export type HijackCandidate = {
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  engine: string;
  mode: "native-cli" | "conversation";
  resume?: string;
  messages?: unknown[];
  accountLabel?: string;
  cwd: string;
  config?: HijackCandidateConfig;
};

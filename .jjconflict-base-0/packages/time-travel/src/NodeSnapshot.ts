export type NodeSnapshot = {
  nodeId: string;
  iteration: number;
  state: string;
  lastAttempt: number | null;
  outputTable: string;
  label: string | null;
};

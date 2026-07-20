export type GatewayUiBootConfig = {
  apiVersion: "v1";
  kind: "gateway" | "workflow";
  workflowKey: string | null;
  mountPath: string;
  rpcPath: string;
  wsPath: string;
  assetBasePath: string;
  props: Record<string, unknown>;
};

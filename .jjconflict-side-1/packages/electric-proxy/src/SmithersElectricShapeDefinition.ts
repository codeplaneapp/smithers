import type { GatewayScope } from "@smithers-orchestrator/gateway/auth/scopes";

export type SmithersElectricShapeDefinition = {
  name: string;
  table: string;
  requiredScope: GatewayScope;
  whereTemplate?: string;
  runIdColumn?: string;
  workspaceIdColumn?: string;
  userPrivateColumn?: string;
  tablePattern?: RegExp;
  description?: string;
};

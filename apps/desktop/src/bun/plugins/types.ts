export type ToolRegistryContext = {
  registerTool: (name: string, handler: unknown) => void;
};

export type RpcRegistryContext = {
  registerNamespace: (name: string, handlers: unknown) => void;
};

export type MigrationContext = {
  addMigration: (id: string, sql: string) => void;
};

export type UiContributionContext = {
  addPanel: (id: string, title: string) => void;
};

export type BunPlugin = {
  id: string;
  registerTools?: (ctx: ToolRegistryContext) => void;
  registerRpc?: (ctx: RpcRegistryContext) => void;
  registerDbMigrations?: (ctx: MigrationContext) => void;
  registerUiContributions?: (ctx: UiContributionContext) => void;
};

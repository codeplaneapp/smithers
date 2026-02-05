import type { BunPlugin, MigrationContext, RpcRegistryContext, ToolRegistryContext, UiContributionContext } from "./types";

export class PluginRegistry {
  private plugins: BunPlugin[] = [];

  register(plugin: BunPlugin) {
    this.plugins.push(plugin);
  }

  applyTools(ctx: ToolRegistryContext) {
    for (const plugin of this.plugins) {
      plugin.registerTools?.(ctx);
    }
  }

  applyRpc(ctx: RpcRegistryContext) {
    for (const plugin of this.plugins) {
      plugin.registerRpc?.(ctx);
    }
  }

  applyMigrations(ctx: MigrationContext) {
    for (const plugin of this.plugins) {
      plugin.registerDbMigrations?.(ctx);
    }
  }

  applyUi(ctx: UiContributionContext) {
    for (const plugin of this.plugins) {
      plugin.registerUiContributions?.(ctx);
    }
  }
}

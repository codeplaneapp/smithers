/** Documentation surfaces owned by `@smthrs/plugin`. */
export const Package = {
  name: "@smthrs/plugin",
  readme: { source: "docs/README.md", target: "packages/plugin/README.md" },
  api: { source: "docs/api.md", target: "docs/pages/api/plugin.md" },
  modules: [
    { namespace: "Config", source: "src/Config.ts", specifier: "@smthrs/plugin/Config" },
    { namespace: "Hooks", source: "src/Hooks.ts", specifier: "@smthrs/plugin/Hooks" },
    { namespace: "Kernel", source: "src/Kernel.ts", specifier: "@smthrs/plugin/Kernel" },
    { namespace: "Plugin", source: "src/Plugin.ts", specifier: "@smthrs/plugin/Plugin" },
    { namespace: "PluginError", source: "src/PluginError.ts", specifier: "@smthrs/plugin/PluginError" },
    { namespace: "Plugins", source: "src/Plugins.ts", specifier: "@smthrs/plugin/Plugins" },
    { namespace: "Resolve", source: "src/Resolve.ts", specifier: "@smthrs/plugin/Resolve" }
  ],
  references: ["docs/pages/design-decisions.md", "docs/pages/release/support-matrix.md"]
} as const

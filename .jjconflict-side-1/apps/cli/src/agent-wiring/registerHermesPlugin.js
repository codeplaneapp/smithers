import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse, stringify } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_SOURCE = join(HERE, "..", "hermes-plugin");
const HOOK_SOURCE = join(HERE, "..", "hermes-plugin-hooks", "smithers");

/**
 * Installs the native Smithers plugin into Hermes (`~/.hermes/plugins/smithers/`)
 * plus its gateway hook (`~/.hermes/hooks/smithers/`), and enables the plugin in
 * `~/.hermes/config.yaml`.
 *
 * This is the rich surface that the bare MCP entry (`registerHermesMcp`) cannot
 * provide: slash commands, a live-run status injector, lifecycle hooks, a
 * bundled skill, and Slack approval buttons. The two are complementary — the MCP
 * entry is the floor (tools work even with user plugins disabled), the plugin is
 * the ceiling.
 *
 * Idempotent: our own plugin directory is replaced wholesale on each run so a
 * stale file from an older version never lingers. Existing Hermes config is
 * preserved; only `plugins.enabled` is touched.
 *
 * @param {object} [opts]
 * @param {string} [opts.homeDir] Home directory override (for tests).
 * @returns {{ agent: "Hermes"; installedPlugin: boolean; path: string; reason?: string; enabled?: boolean }}
 */
export function registerHermesPlugin({ homeDir = homedir() } = {}) {
  const hermesDir = join(homeDir, ".hermes");
  const pluginDest = join(hermesDir, "plugins", "smithers");

  // Detect Hermes by the presence of its config directory (same probe as the
  // MCP wiring).
  if (!existsSync(hermesDir)) {
    return { agent: "Hermes", installedPlugin: false, path: pluginDest, reason: "not-detected" };
  }
  if (!existsSync(PLUGIN_SOURCE)) {
    return { agent: "Hermes", installedPlugin: false, path: pluginDest, reason: "plugin-source-missing" };
  }

  // 1. Install the plugin tree (replace wholesale for idempotency).
  mkdirSync(dirname(pluginDest), { recursive: true });
  rmSync(pluginDest, { recursive: true, force: true });
  cpSync(PLUGIN_SOURCE, pluginDest, { recursive: true });

  // 2. Install the gateway hook (best-effort; not fatal if it can't be copied).
  if (existsSync(HOOK_SOURCE)) {
    const hookDest = join(hermesDir, "hooks", "smithers");
    try {
      mkdirSync(dirname(hookDest), { recursive: true });
      rmSync(hookDest, { recursive: true, force: true });
      cpSync(HOOK_SOURCE, hookDest, { recursive: true });
    } catch {
      // A host without gateway hooks support is fine — the plugin still loads.
    }
  }

  // 3. Enable the plugin in config.yaml so it loads without `hermes plugins
  //    enable smithers`. Preserve everything else; a deny-list entry wins in
  //    Hermes, so also drop "smithers" from plugins.disabled if present.
  const enabled = enablePluginInConfig(join(hermesDir, "config.yaml"));

  return { agent: "Hermes", installedPlugin: true, path: pluginDest, enabled };
}

/**
 * @param {string} configPath
 * @returns {boolean} whether the enable write succeeded.
 */
function enablePluginInConfig(configPath) {
  /** @type {Record<string, any>} */
  let config = {};
  if (existsSync(configPath)) {
    try {
      config = parse(readFileSync(configPath, "utf8")) ?? {};
    } catch {
      return false;
    }
    if (typeof config !== "object" || Array.isArray(config)) return false;
  }

  const plugins = config.plugins && typeof config.plugins === "object" && !Array.isArray(config.plugins)
    ? config.plugins
    : {};
  const enabledList = Array.isArray(plugins.enabled) ? plugins.enabled : [];
  if (!enabledList.includes("smithers")) enabledList.push("smithers");
  plugins.enabled = enabledList;
  if (Array.isArray(plugins.disabled)) {
    plugins.disabled = plugins.disabled.filter((/** @type {unknown} */ name) => name !== "smithers");
  }
  config.plugins = plugins;

  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, stringify(config));
    return true;
  } catch {
    return false;
  }
}

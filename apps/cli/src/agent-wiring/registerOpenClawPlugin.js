import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_SOURCE = join(HERE, "..", "openclaw-plugin");

/**
 * Installs the native Smithers plugin into OpenClaw
 * (`~/.openclaw/extensions/smithers/`) and enables it in
 * `~/.openclaw/openclaw.json`.
 *
 * OpenClaw auto-discovers package or bundle directories under
 * `~/.openclaw/extensions`, but workspace/local plugins must be explicitly
 * enabled. This writer preserves existing config, only adding:
 *   - plugins.entries.smithers.enabled = true
 *   - smithers in plugins.allow when that allow-list already exists
 *
 * @param {object} [opts]
 * @param {string} [opts.homeDir] Home directory override (for tests).
 * @returns {{ agent: "OpenClaw"; installedPlugin: boolean; path: string; reason?: string; enabled?: boolean }}
 */
export function registerOpenClawPlugin({ homeDir = homedir() } = {}) {
  const openclawDir = join(homeDir, ".openclaw");
  const pluginDest = join(openclawDir, "extensions", "smithers");
  const configPath = join(openclawDir, "openclaw.json");

  if (!existsSync(openclawDir)) {
    return { agent: "OpenClaw", installedPlugin: false, path: pluginDest, reason: "not-detected" };
  }
  if (!existsSync(PLUGIN_SOURCE)) {
    return { agent: "OpenClaw", installedPlugin: false, path: pluginDest, reason: "plugin-source-missing" };
  }

  const enabled = enablePluginInConfig(configPath);
  if (!enabled) {
    return {
      agent: "OpenClaw",
      installedPlugin: false,
      path: pluginDest,
      reason: "unparseable-config",
      enabled: false,
    };
  }

  mkdirSync(dirname(pluginDest), { recursive: true });
  rmSync(pluginDest, { recursive: true, force: true });
  cpSync(PLUGIN_SOURCE, pluginDest, { recursive: true });

  return { agent: "OpenClaw", installedPlugin: true, path: pluginDest, enabled };
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
      config = JSON.parse(readFileSync(configPath, "utf8")) ?? {};
    } catch {
      return false;
    }
    if (typeof config !== "object" || Array.isArray(config)) return false;
  }

  const plugins =
    config.plugins && typeof config.plugins === "object" && !Array.isArray(config.plugins) ? config.plugins : {};
  const entries =
    plugins.entries && typeof plugins.entries === "object" && !Array.isArray(plugins.entries) ? plugins.entries : {};
  const smithers =
    entries.smithers && typeof entries.smithers === "object" && !Array.isArray(entries.smithers)
      ? entries.smithers
      : {};
  smithers.enabled = true;
  entries.smithers = smithers;
  plugins.entries = entries;

  if (Array.isArray(plugins.allow) && !plugins.allow.includes("smithers")) {
    plugins.allow.push("smithers");
  }
  if (Array.isArray(plugins.block)) {
    plugins.block = plugins.block.filter((/** @type {unknown} */ name) => name !== "smithers");
  }
  if (Array.isArray(plugins.disabled)) {
    plugins.disabled = plugins.disabled.filter((/** @type {unknown} */ name) => name !== "smithers");
  }
  config.plugins = plugins;

  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

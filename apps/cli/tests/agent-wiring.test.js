import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

import { linkPiSkills } from "../src/agent-wiring/linkPiSkills.js";
import { mcpAddFallbackMessage } from "../src/agent-wiring/mcpAddFallbackMessage.js";
import { parseAgentWiringArgv } from "../src/agent-wiring/parseAgentWiringArgv.js";
import { registerHermesMcp } from "../src/agent-wiring/registerHermesMcp.js";
import { registerHermesPlugin } from "../src/agent-wiring/registerHermesPlugin.js";
import { registerOpenClawMcp } from "../src/agent-wiring/registerOpenClawMcp.js";
import { registerOpenClawPlugin } from "../src/agent-wiring/registerOpenClawPlugin.js";
import { wireExtraAgents } from "../src/agent-wiring/wireExtraAgents.js";

/** @type {string[]} */
const tempDirs = [];
function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-wiring-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

const MCP = { name: "smithers", command: "bunx", args: ["smithers-orchestrator", "--mcp"] };

describe("parseAgentWiringArgv", () => {
  test("recognizes `mcp add` and `skills add`", () => {
    expect(parseAgentWiringArgv(["mcp", "add"])).toEqual({ kind: "mcp", global: true });
    expect(parseAgentWiringArgv(["skills", "add"])).toEqual({ kind: "skills", global: true });
  });

  test("returns null for unrelated commands", () => {
    expect(parseAgentWiringArgv(["mcp"])).toBeNull();
    expect(parseAgentWiringArgv(["up", "workflow.tsx"])).toBeNull();
    expect(parseAgentWiringArgv(["skills", "list"])).toBeNull();
  });

  test("parses --no-global, --agent, and --command", () => {
    expect(parseAgentWiringArgv(["mcp", "add", "--no-global", "--agent", "hermes", "-a", "Cursor"]))
      .toEqual({ kind: "mcp", global: false, agents: ["hermes", "cursor"] });
    expect(parseAgentWiringArgv(["mcp", "add", "--command", "pnpm smithers --mcp"]))
      .toEqual({ kind: "mcp", global: true, command: "pnpm", args: ["smithers", "--mcp"] });
    expect(parseAgentWiringArgv(["skills", "add", "--depth", "2"]))
      .toEqual({ kind: "skills", global: true });
  });
});

describe("mcpAddFallbackMessage", () => {
  test("shows the `--` separated manual command for the common agents", () => {
    const msg = mcpAddFallbackMessage();
    expect(msg).toContain("codex mcp add smithers -- bunx smithers-orchestrator --mcp");
    expect(msg).toContain("claude mcp add smithers -- bunx smithers-orchestrator --mcp");
    // The hand-written config must split command from args correctly.
    expect(msg).toContain('"command": "bunx", "args": ["smithers-orchestrator", "--mcp"]');
    expect(msg).toContain("smithers.sh/integrations/mcp-server");
  });

  test("targets the agents the user asked for", () => {
    const msg = mcpAddFallbackMessage({ agents: ["cursor"] });
    expect(msg).toContain("cursor mcp add smithers -- bunx smithers-orchestrator --mcp");
    expect(msg).not.toContain("codex mcp add");
  });

  test("honors a custom launch command", () => {
    const msg = mcpAddFallbackMessage({ launchCommand: "pnpm smithers --mcp", agents: ["codex"] });
    expect(msg).toContain("codex mcp add smithers -- pnpm smithers --mcp");
    expect(msg).toContain('"command": "pnpm", "args": ["smithers", "--mcp"]');
  });
});

describe("registerHermesMcp", () => {
  test("skips when Hermes is not installed", () => {
    const home = tempHome();
    const result = registerHermesMcp({ ...MCP, homeDir: home });
    expect(result).toMatchObject({ agent: "Hermes", registered: false, reason: "not-detected" });
  });

  test("writes the mcp_servers entry into config.yaml", () => {
    const home = tempHome();
    mkdirSync(join(home, ".hermes"), { recursive: true });
    const result = registerHermesMcp({ ...MCP, homeDir: home });
    expect(result.registered).toBe(true);
    const config = parse(readFileSync(result.path, "utf8"));
    expect(config.mcp_servers.smithers).toEqual({ command: "bunx", args: ["smithers-orchestrator", "--mcp"] });
  });

  test("preserves existing config and other servers", () => {
    const home = tempHome();
    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(join(home, ".hermes", "config.yaml"), "model: hermes-4\nmcp_servers:\n  other:\n    command: x\n");
    const result = registerHermesMcp({ ...MCP, homeDir: home });
    const config = parse(readFileSync(result.path, "utf8"));
    expect(config.model).toBe("hermes-4");
    expect(config.mcp_servers.other).toEqual({ command: "x" });
    expect(config.mcp_servers.smithers.command).toBe("bunx");
  });
});

describe("registerHermesPlugin", () => {
  test("skips when Hermes is not installed", () => {
    const home = tempHome();
    const result = registerHermesPlugin({ homeDir: home });
    expect(result).toMatchObject({ agent: "Hermes", installedPlugin: false, reason: "not-detected" });
  });

  test("installs the plugin tree, gateway hook, and enables it", () => {
    const home = tempHome();
    mkdirSync(join(home, ".hermes"), { recursive: true });
    const result = registerHermesPlugin({ homeDir: home });
    expect(result.installedPlugin).toBe(true);
    expect(result.enabled).toBe(true);
    // Plugin files landed.
    expect(existsSync(join(home, ".hermes", "plugins", "smithers", "plugin.yaml"))).toBe(true);
    expect(existsSync(join(home, ".hermes", "plugins", "smithers", "__init__.py"))).toBe(true);
    expect(existsSync(join(home, ".hermes", "plugins", "smithers", "skills", "orchestrate", "SKILL.md"))).toBe(true);
    // Gateway hook landed.
    expect(existsSync(join(home, ".hermes", "hooks", "smithers", "HOOK.yaml"))).toBe(true);
    // Enabled in config.
    const config = parse(readFileSync(join(home, ".hermes", "config.yaml"), "utf8"));
    expect(config.plugins.enabled).toContain("smithers");
  });

  test("preserves existing config and drops a stale disabled entry", () => {
    const home = tempHome();
    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(
      join(home, ".hermes", "config.yaml"),
      "model: hermes-4\nplugins:\n  enabled: [other]\n  disabled: [smithers]\n",
    );
    registerHermesPlugin({ homeDir: home });
    const config = parse(readFileSync(join(home, ".hermes", "config.yaml"), "utf8"));
    expect(config.model).toBe("hermes-4");
    expect(config.plugins.enabled).toEqual(expect.arrayContaining(["other", "smithers"]));
    expect(config.plugins.disabled).not.toContain("smithers");
  });

  test("is idempotent and replaces a stale plugin file", () => {
    const home = tempHome();
    mkdirSync(join(home, ".hermes", "plugins", "smithers"), { recursive: true });
    const stale = join(home, ".hermes", "plugins", "smithers", "stale.py");
    writeFileSync(stale, "# stale\n");
    registerHermesPlugin({ homeDir: home });
    registerHermesPlugin({ homeDir: home });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(home, ".hermes", "plugins", "smithers", "plugin.yaml"))).toBe(true);
  });
});

describe("registerOpenClawMcp", () => {
  test("skips when OpenClaw is not installed", () => {
    const home = tempHome();
    const result = registerOpenClawMcp({ ...MCP, homeDir: home });
    expect(result).toMatchObject({ agent: "OpenClaw", registered: false, reason: "not-detected" });
  });

  test("writes mcp.servers into openclaw.json and preserves other keys", () => {
    const home = tempHome();
    mkdirSync(join(home, ".openclaw"), { recursive: true });
    writeFileSync(join(home, ".openclaw", "openclaw.json"), JSON.stringify({ channels: { slack: true }, mcp: { servers: { other: { command: "x" } } } }));
    const result = registerOpenClawMcp({ ...MCP, homeDir: home });
    expect(result.registered).toBe(true);
    const config = JSON.parse(readFileSync(result.path, "utf8"));
    expect(config.channels).toEqual({ slack: true });
    expect(config.mcp.servers.other).toEqual({ command: "x" });
    expect(config.mcp.servers.smithers).toEqual({ command: "bunx", args: ["smithers-orchestrator", "--mcp"] });
  });

  test("does not clobber an unparseable config", () => {
    const home = tempHome();
    mkdirSync(join(home, ".openclaw"), { recursive: true });
    const path = join(home, ".openclaw", "openclaw.json");
    writeFileSync(path, "{ /* json5 comment */ mcp: {} }");
    const result = registerOpenClawMcp({ ...MCP, homeDir: home });
    expect(result).toMatchObject({ registered: false, reason: "unparseable-config" });
    expect(readFileSync(path, "utf8")).toContain("json5 comment");
  });
});

describe("registerOpenClawPlugin", () => {
  test("skips when OpenClaw is not installed", () => {
    const home = tempHome();
    const result = registerOpenClawPlugin({ homeDir: home });
    expect(result).toMatchObject({ agent: "OpenClaw", installedPlugin: false, reason: "not-detected" });
  });

  test("installs the plugin tree and enables it", () => {
    const home = tempHome();
    mkdirSync(join(home, ".openclaw"), { recursive: true });
    const result = registerOpenClawPlugin({ homeDir: home });
    expect(result.installedPlugin).toBe(true);
    expect(result.enabled).toBe(true);
    expect(existsSync(join(home, ".openclaw", "extensions", "smithers", "package.json"))).toBe(true);
    expect(existsSync(join(home, ".openclaw", "extensions", "smithers", "openclaw.plugin.json"))).toBe(true);
    expect(existsSync(join(home, ".openclaw", "extensions", "smithers", "dist", "index.js"))).toBe(true);
    expect(existsSync(join(home, ".openclaw", "extensions", "smithers", "skills", "orchestrate", "SKILL.md"))).toBe(true);
    const config = JSON.parse(readFileSync(join(home, ".openclaw", "openclaw.json"), "utf8"));
    expect(config.plugins.entries.smithers.enabled).toBe(true);
  });

  test("preserves config, allows smithers when an allow-list exists, and drops deny entries", () => {
    const home = tempHome();
    mkdirSync(join(home, ".openclaw"), { recursive: true });
    writeFileSync(
      join(home, ".openclaw", "openclaw.json"),
      JSON.stringify({
        models: { default: "local" },
        plugins: {
          allow: ["other"],
          block: ["smithers"],
          disabled: ["smithers"],
          entries: {
            other: { enabled: true },
            smithers: { config: { existing: true }, enabled: false },
          },
        },
      }),
    );
    registerOpenClawPlugin({ homeDir: home });
    const config = JSON.parse(readFileSync(join(home, ".openclaw", "openclaw.json"), "utf8"));
    expect(config.models.default).toBe("local");
    expect(config.plugins.entries.other.enabled).toBe(true);
    expect(config.plugins.entries.smithers.config).toEqual({ existing: true });
    expect(config.plugins.entries.smithers.enabled).toBe(true);
    expect(config.plugins.allow).toEqual(["other", "smithers"]);
    expect(config.plugins.block).not.toContain("smithers");
    expect(config.plugins.disabled).not.toContain("smithers");
  });

  test("does not clobber an unparseable config", () => {
    const home = tempHome();
    mkdirSync(join(home, ".openclaw"), { recursive: true });
    const path = join(home, ".openclaw", "openclaw.json");
    writeFileSync(path, "{ /* json5 comment */ plugins: {} }");
    const result = registerOpenClawPlugin({ homeDir: home });
    expect(result).toMatchObject({ installedPlugin: false, reason: "unparseable-config", enabled: false });
    expect(readFileSync(path, "utf8")).toContain("json5 comment");
    expect(existsSync(join(home, ".openclaw", "extensions", "smithers"))).toBe(false);
  });

  test("is idempotent and replaces stale plugin files", () => {
    const home = tempHome();
    mkdirSync(join(home, ".openclaw", "extensions", "smithers"), { recursive: true });
    const stale = join(home, ".openclaw", "extensions", "smithers", "stale.js");
    writeFileSync(stale, "// stale\n");
    registerOpenClawPlugin({ homeDir: home });
    registerOpenClawPlugin({ homeDir: home });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(home, ".openclaw", "extensions", "smithers", "openclaw.plugin.json"))).toBe(true);
  });
});

describe("linkPiSkills", () => {
  test("skips when Pi is not installed", () => {
    const home = tempHome();
    const result = linkPiSkills({ homeDir: home });
    expect(result).toMatchObject({ agent: "Pi", linked: [], reason: "not-detected" });
  });

  test("copies canonical skills into ~/.pi/agent/skills", () => {
    const home = tempHome();
    mkdirSync(join(home, ".pi"), { recursive: true });
    const canonical = join(home, ".agents", "skills", "smithers");
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, "SKILL.md"), "---\nname: smithers\n---\nbody\n");
    const result = linkPiSkills({ homeDir: home });
    expect(result.linked).toEqual(["smithers"]);
    expect(existsSync(join(home, ".pi", "agent", "skills", "smithers", "SKILL.md"))).toBe(true);
  });
});

describe("wireExtraAgents", () => {
  test("mcp kind wires Hermes and OpenClaw when detected", () => {
    const home = tempHome();
    mkdirSync(join(home, ".hermes"), { recursive: true });
    mkdirSync(join(home, ".openclaw"), { recursive: true });
    const results = wireExtraAgents({ kind: "mcp", homeDir: home });
    const wired = results.filter((r) => r.registered).map((r) => r.agent).sort();
    expect(wired).toEqual(["Hermes", "OpenClaw"]);
    const plugins = results.filter((r) => r.installedPlugin).map((r) => r.agent).sort();
    expect(plugins).toEqual(["Hermes", "OpenClaw"]);
  });

  test("--agent filter limits which agents are wired", () => {
    const home = tempHome();
    mkdirSync(join(home, ".hermes"), { recursive: true });
    mkdirSync(join(home, ".openclaw"), { recursive: true });
    const results = wireExtraAgents({ kind: "mcp", agents: ["hermes"], homeDir: home });
    // Hermes gets both the MCP entry (floor) and the native plugin (ceiling).
    expect(results.map((r) => r.agent)).toEqual(["Hermes", "Hermes"]);
    expect(results.some((r) => r.registered)).toBe(true);
    expect(results.some((r) => r.installedPlugin)).toBe(true);
  });

  test("--agent filter can target only OpenClaw", () => {
    const home = tempHome();
    mkdirSync(join(home, ".hermes"), { recursive: true });
    mkdirSync(join(home, ".openclaw"), { recursive: true });
    const results = wireExtraAgents({ kind: "mcp", agents: ["openclaw"], homeDir: home });
    expect(results.map((r) => r.agent)).toEqual(["OpenClaw", "OpenClaw"]);
    expect(results.some((r) => r.registered)).toBe(true);
    expect(results.some((r) => r.installedPlugin)).toBe(true);
    expect(existsSync(join(home, ".hermes", "plugins", "smithers"))).toBe(false);
  });

  test("skills kind wires Pi", () => {
    const home = tempHome();
    mkdirSync(join(home, ".pi"), { recursive: true });
    const canonical = join(home, ".agents", "skills", "smithers");
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, "SKILL.md"), "---\nname: smithers\n---\nbody\n");
    const results = wireExtraAgents({ kind: "skills", homeDir: home });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ agent: "Pi", linked: ["smithers"] });
  });
});

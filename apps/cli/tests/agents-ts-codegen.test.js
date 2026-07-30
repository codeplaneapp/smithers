import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { addAccount } from "@smithers-orchestrator/accounts";
import { extractGeneratedDetectionProviderIds, generateAgentsTs } from "../src/agent-detection.js";
import { createExecutableDir, writeFakeClaudeBinary } from "../../../packages/smithers/tests/e2e-helpers.js";

/** @type {string[]} */
const tempDirs = [];
afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function newSmithersHome() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-codegen-"));
  tempDirs.push(dir);
  return { SMITHERS_HOME: dir, HOME: dir };
}

function uncommented(source) {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

const CODEX_DEFAULT_TIERS = {
  cheapFast: "Luna",
  research: "Luna",
  midTier: "Terra",
  smartTool: "Terra",
  validate: "Terra",
  review: "Sol",
};

// Building (implement/smart) plus orchestration/gating and planning are
// Claude-led as of registry v7 (Claude Opus 5 is the default implementer);
// Codex appears in these chains only as an availability fallback.
const CLAUDE_LED_TIERS = ["planning", "orchestrator", "implement", "smart"];
const ALL_TIERS = [...Object.keys(CODEX_DEFAULT_TIERS), ...CLAUDE_LED_TIERS];

function activePoolProviders(source, pool) {
  const match = uncommented(source).match(new RegExp(`(?:^|\\n)  ${pool}: \\[([\\s\\S]*?)\\n  \\],`));
  expect(match, `missing generated ${pool} pool`).toBeTruthy();
  return [...match[1].matchAll(/providers\.([A-Za-z_$][\w$]*)/g)].map((entry) => entry[1]);
}

function expectCodexFirstDefaultTiers(source, providerPrefix) {
  for (const [tier, modelTier] of Object.entries(CODEX_DEFAULT_TIERS)) {
    expect(activePoolProviders(source, tier)[0], `${tier} must start with Codex`).toBe(`${providerPrefix}${modelTier}`);
  }
}

describe("generateAgentsTs (account-driven)", () => {
  test("emits one provider per account and a pool per engine family", () => {
    const env = newSmithersHome();
    addAccount(
      { label: "claude-work", provider: "claude-code", configDir: `${env.HOME}/.smithers/accounts/claude-work` },
      { env },
    );
    addAccount(
      {
        label: "claude-personal",
        provider: "claude-code",
        configDir: `${env.HOME}/.smithers/accounts/claude-personal`,
      },
      { env },
    );
    addAccount(
      { label: "codex-work", provider: "codex", configDir: `${env.HOME}/.smithers/accounts/codex-work` },
      { env },
    );
    const generated = generateAgentsTs(env);
    // sentinel + ledger pointer
    expect(generated).toContain("// smithers-source: generated");
    expect(generated).toContain("~/.smithers/accounts.json");
    // imports the SDK class once per used engine
    expect(generated).toContain("ClaudeCodeAgent as SmithersClaudeCodeAgent");
    expect(generated).toContain("CodexAgent as SmithersCodexAgent");
    // one provider per account, camel-cased label
    expect(generated).toContain("claudeWork: new SmithersClaudeCodeAgent(");
    expect(generated).toContain("claudePersonal: new SmithersClaudeCodeAgent(");
    expect(generated).toContain("codexWork: new SmithersCodexAgent(");
    expect(generated).toContain('id: "smithers-account:claude-work"');
    // pools group by engine family
    expect(generated).toMatch(/claude:\s*\[\s*providers\.claudeWork,\s*providers\.claudePersonal,\s*\]/);
    expect(generated).toMatch(/codex:\s*\[\s*providers\.codexWork,\s*\]/);
    // A registered Codex account gets role-specific model siblings. Claude
    // accounts remain behind Codex as runtime fallbacks.
    expect(generated).toContain('codexWorkSol: new SmithersCodexAgent({ model: "gpt-5.6-sol"');
    expect(generated).toContain('codexWorkTerra: new SmithersCodexAgent({ model: "gpt-5.6-terra"');
    expect(generated).toContain('codexWorkLuna: new SmithersCodexAgent({ model: "gpt-5.6-luna"');
    expectCodexFirstDefaultTiers(generated, "codexWork");
    // Claude accounts lead implementation (registry v7); the Codex Terra
    // sibling follows as the checking / second-build lane.
    const implementPool = activePoolProviders(generated, "implement");
    expect(implementPool[0]).toBe("claudeWork");
    expect(implementPool).toContain("codexWorkTerra");
    // Claude accounts lead the orchestrator/planning seats; Codex Sol is
    // only the availability fallback behind them.
    expect(activePoolProviders(generated, "orchestrator").slice(0, 3)).toEqual([
      "claudeWork",
      "claudePersonal",
      "codexWorkSol",
    ]);
    expect(activePoolProviders(generated, "planning").slice(0, 3)).toEqual([
      "claudeWork",
      "claudePersonal",
      "codexWorkSol",
    ]);
    expect(uncommented(generated)).not.toContain("cwd: process.cwd()");
  });

  test("keeps every registered Codex account together behind the Claude implement lead", () => {
    const env = newSmithersHome();
    for (const label of ["codex-a", "codex-b", "codex-c", "codex-d"]) {
      addAccount({ label, provider: "codex", configDir: `${env.HOME}/.smithers/accounts/${label}` }, { env });
    }
    addAccount(
      { label: "claude-backup", provider: "claude-code", configDir: `${env.HOME}/.smithers/accounts/claude-backup` },
      { env },
    );

    const providers = activePoolProviders(generateAgentsTs(env), "implement");
    expect(providers[0]).toBe("claudeBackup");
    expect(providers.slice(1, 5)).toEqual(["codexATerra", "codexBTerra", "codexCTerra", "codexDTerra"]);
  });

  test("path.join(homedir(), ...) is used for paths under $HOME", () => {
    const env = newSmithersHome();
    addAccount(
      { label: "claude-x", provider: "claude-code", configDir: `${env.HOME}/.smithers/accounts/claude-x` },
      { env },
    );
    const generated = generateAgentsTs(env);
    expect(generated).toContain('import { homedir } from "node:os"');
    expect(generated).toContain('import path from "node:path"');
    expect(generated).toContain('configDir: path.join(homedir(), ".smithers/accounts/claude-x")');
    // and never the absolute path leaked literally
    expect(generated).not.toContain(env.HOME + "/.smithers/accounts/claude-x");
  });

  test("absolute path outside $HOME is preserved verbatim", () => {
    const env = newSmithersHome();
    addAccount({ label: "claude-custom", provider: "claude-code", configDir: "/opt/shared/claude" }, { env });
    const generated = generateAgentsTs(env);
    expect(generated).toContain('configDir: "/opt/shared/claude"');
  });

  test("api-key providers resolve keys from the account store and join the right pool", () => {
    const env = newSmithersHome();
    addAccount({ label: "openai-prod", provider: "openai-api", apiKey: "sk-xyz", model: "gpt-5" }, { env });
    addAccount({ label: "anthropic-prod", provider: "anthropic-api", apiKey: "sk-ant" }, { env });
    const generated = generateAgentsTs(env);
    expect(generated).not.toContain("sk-xyz");
    expect(generated).not.toContain("sk-ant");
    expect(generated).toContain('apiKey: registeredAccountApiKey("openai-prod")');
    expect(generated).toContain('apiKey: registeredAccountApiKey("anthropic-prod")');
    // openai-api goes in the codex pool, anthropic-api in the claude pool
    expect(generated).toMatch(/codex:\s*\[\s*providers\.openaiProd,\s*\]/);
    expect(generated).toMatch(/claude:\s*\[\s*providers\.anthropicProd,\s*\]/);
    // user-specified model wins over the default
    expect(generated).toContain('model: "gpt-5"');
    // The explicit base-account pin does not weaken the Smithers default
    // roles: its generated siblings still use Sol/Terra/Luna.
    expect(generated).toContain('openaiProdSol: new SmithersCodexAgent({ model: "gpt-5.6-sol"');
    expect(generated).toContain('openaiProdTerra: new SmithersCodexAgent({ model: "gpt-5.6-terra"');
    expect(generated).toContain('openaiProdLuna: new SmithersCodexAgent({ model: "gpt-5.6-luna"');
    expectCodexFirstDefaultTiers(generated, "openaiProd");
    expect(activePoolProviders(generated, "review")).toContain("anthropicProd");
    // The Claude account leads implementation; the Codex Terra sibling
    // follows as the checking / second-build lane.
    expect(activePoolProviders(generated, "implement").slice(0, 2)).toEqual(["anthropicProd", "openaiProdTerra"]);
    // The Claude account leads orchestration; the Codex Sol sibling stays
    // behind it as the availability fallback.
    expect(activePoolProviders(generated, "orchestrator").slice(0, 2)).toEqual(["anthropicProd", "openaiProdSol"]);
  });

  test("does not serialize both configDir and apiKey for malformed account entries", () => {
    const env = newSmithersHome();
    writeFileSync(
      join(env.SMITHERS_HOME, "accounts.json"),
      JSON.stringify({
        version: 1,
        accounts: [{ label: "claude-mixed", provider: "claude-code", configDir: "/tmp/claude", apiKey: "sk-leak" }],
      }),
    );

    expect(() => generateAgentsTs(env)).toThrow(/configDir.*apiKey|apiKey.*configDir/);
  });

  test("falls back to detection-based output when no accounts are registered", () => {
    const env = newSmithersHome();
    const binDir = createExecutableDir();
    writeFakeClaudeBinary(binDir);
    // No accounts added; reuses existing logic. Detection requires at least
    // one usable agent; we simulate one by setting an API key env var.
    const generated = generateAgentsTs({
      ...env,
      PATH: [binDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
      ANTHROPIC_API_KEY: "sk-ant-test",
    });
    expect(generated).toContain("// smithers-source: generated");
    // Detection-based output does NOT pull in the accounts.json header.
    expect(generated).not.toContain("~/.smithers/accounts.json");
  });

  test("Codex detection emits Sol, Terra, and Luna first with runtime fallbacks", () => {
    const env = newSmithersHome();
    const generated = generateAgentsTs(env, {
      preserveProviderIds: ["claude", "codex", "opencode"],
    });

    expect(generated).not.toContain("gpt-5.3-codex");
    expect(generated).toContain('codexSol: new SmithersCodexAgent({ model: "gpt-5.6-sol"');
    expect(generated).toContain('config: { model_reasoning_effort: "xhigh" }');
    expect(generated).toContain('codexTerra: new SmithersCodexAgent({ model: "gpt-5.6-terra"');
    expect(generated).toContain('codexLuna: new SmithersCodexAgent({ model: "gpt-5.6-luna"');
    expectCodexFirstDefaultTiers(generated, "codex");
    // claudeOpus (the Opus 5 variant) leads implementation; Codex Terra is
    // spliced in right behind it.
    expect(activePoolProviders(generated, "implement").slice(0, 3)).toEqual([
      "claudeOpus",
      "codexTerra",
      "claudeSonnet",
    ]);
    expect(activePoolProviders(generated, "review").slice(1)).toEqual(["claude", "claudeOpus", "claudeSonnet"]);
    // Detected Claude variants lead orchestration and planning; Codex Sol
    // is spliced in behind them as the availability fallback.
    expect(activePoolProviders(generated, "orchestrator")).toEqual(["claudeOpus", "claude", "codexSol", "opencode"]);
    expect(activePoolProviders(generated, "planning")).toEqual(["claude", "claudeOpus", "codexSol", "claudeSonnet"]);
  });

  test("direct generated CLI providers leave cwd to the task root and Worktree", () => {
    const env = newSmithersHome();
    const generated = generateAgentsTs(env, {
      preserveProviderIds: ["claude", "codex", "opencode", "antigravity", "vibe", "hermes", "openclaw"],
      scaffoldProviderIds: [],
    });

    expect(uncommented(generated)).not.toContain("cwd: process.cwd()");
    expect(generated).toContain('claude: new SmithersClaudeCodeAgent({ model: "claude-fable-5" })');
    expect(generated).toContain('opencode: new SmithersOpenCodeAgent({ model: "anthropic/claude-fable-5" })');
    expect(generated).toContain("antigravity: new SmithersAntigravityAgent()");
    expect(generated).toContain('vibe: new SmithersVibeAgent({ agent: "auto-approve" })');
    expect(generated).toContain("hermes: new SmithersHermesCliAgent()");
    expect(generated).toContain("openclaw: new SmithersOpenClawAgent()");
  });

  test("mixed detected and registered fallbacks follow tier priority before the pool cap", () => {
    const env = newSmithersHome();
    addAccount(
      {
        label: "kimi-backup",
        provider: "kimi",
        configDir: `${env.HOME}/.smithers/accounts/kimi-backup`,
      },
      { env },
    );
    const generated = generateAgentsTs(env, {
      preserveProviderIds: ["codex", "claude", "opencode", "antigravity"],
    });

    expect(activePoolProviders(generated, "research")).toEqual(["codexLuna", "kimiBackup", "antigravity", "opencode"]);
    expect(activePoolProviders(generated, "implement").slice(0, 4)).toEqual([
      "claudeOpus",
      "codexTerra",
      "claudeSonnet",
      "kimiBackup",
    ]);
  });

  test("detection smart pools use OpenCode when it is the only preserved CLI provider", () => {
    const env = newSmithersHome();
    const generated = generateAgentsTs(env, {
      preserveProviderIds: ["opencode"],
    });
    const active = uncommented(generated);
    expect(generated).toContain("opencode: new SmithersOpenCodeAgent(");
    expect(active).not.toContain("openrouter: createOpenRouterAgent()");
    expect(active).toMatch(/smart:\s*\[\s*providers\.opencode,/);
    expect(active).toMatch(/smartTool:\s*\[\s*providers\.opencode,/);
    expect(active).toMatch(/review:\s*\[\s*providers\.opencode,/);
    for (const tier of ALL_TIERS) {
      expect(activePoolProviders(generated, tier)).toEqual(["opencode"]);
    }
  });

  test("preserves generated detection providers when adding accounts in a different shell", () => {
    const env = newSmithersHome();
    const binDir = createExecutableDir();
    writeFakeClaudeBinary(binDir);
    const initial = generateAgentsTs({
      ...env,
      PATH: [binDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
      ANTHROPIC_API_KEY: "sk-ant-test",
    });
    expect(initial).toContain("claude: new SmithersClaudeCodeAgent(");
    addAccount(
      { label: "codex-prod", provider: "codex", configDir: `${env.HOME}/.smithers/accounts/codex-prod` },
      { env },
    );
    const regenerated = generateAgentsTs(env, {
      preserveProviderIds: extractGeneratedDetectionProviderIds(initial),
    });
    expect(regenerated).toContain("claude: new SmithersClaudeCodeAgent(");
    expect(regenerated).toContain("claudeOpus: new SmithersClaudeCodeAgent(");
    expect(regenerated).toContain("claudeSonnet: new SmithersClaudeCodeAgent(");
    expect(regenerated).toContain("codexProd: new SmithersCodexAgent(");
    expect(regenerated).toContain("codexProdSol: new SmithersCodexAgent(");
    expect(regenerated).toContain("codexProdTerra: new SmithersCodexAgent(");
    expect(regenerated).toContain("codexProdLuna: new SmithersCodexAgent(");
    expectCodexFirstDefaultTiers(regenerated, "codexProd");
    expect(activePoolProviders(regenerated, "planning")).toContain("claude");
  });

  test("preserved OpenRouter default is demoted below a real account added later (never the hot path)", () => {
    const env = newSmithersHome();
    const binDir = createExecutableDir(); // no agent binaries → nothing detected
    // First init on a machine with no agents: the keyless OpenRouter default
    // is the active provider and gets preserved.
    const initial = generateAgentsTs({ ...env, PATH: `${binDir}:/usr/bin:/bin` });
    expect(initial).toContain("openrouter: createOpenRouterAgent()");
    expect([...extractGeneratedDetectionProviderIds(initial)]).toEqual(["openrouter"]);

    // Later the user adds a real subscription account and regenerates
    // (the `smithers agent add` path forwards the preserved ids).
    addAccount(
      { label: "claude-main", provider: "claude-code", configDir: `${env.HOME}/.smithers/accounts/claude-main` },
      { env },
    );
    const regenerated = generateAgentsTs(
      { ...env, PATH: `${binDir}:/usr/bin:/bin` },
      { preserveProviderIds: extractGeneratedDetectionProviderIds(initial) },
    );

    // In every pool that has both, the real account must precede the keyless
    // OpenRouter default (which throws until OPENROUTER_API_KEY is set), so
    // attempt 1 hits the paid account, not a guaranteed throw.
    for (const pool of ["smart", "smartTool", "cheapFast", "review"]) {
      const match = regenerated.match(new RegExp(`${pool}:\\s*\\[([^\\]]*)\\]`));
      expect(match).toBeTruthy();
      const members = match[1];
      const idxAccount = members.indexOf("providers.claudeMain");
      const idxDefault = members.indexOf("providers.openrouter");
      if (idxAccount >= 0 && idxDefault >= 0) {
        expect(idxDefault).toBeGreaterThan(idxAccount);
      }
    }
  });

  test("does not preserve account labels that collide with generated provider ids", () => {
    const env = newSmithersHome();
    addAccount({ label: "codex", provider: "codex", configDir: `${env.HOME}/.smithers/accounts/codex` }, { env });
    addAccount(
      { label: "claude-sonnet", provider: "claude-code", configDir: `${env.HOME}/.smithers/accounts/claude-sonnet` },
      { env },
    );

    const generated = generateAgentsTs(env);
    const preserved = extractGeneratedDetectionProviderIds(generated);
    expect([...preserved]).toEqual([]);

    const regenerated = generateAgentsTs(env, { preserveProviderIds: preserved });
    expect(regenerated).toContain("codex: new SmithersCodexAgent(");
    expect(regenerated).toContain("codexSol: new SmithersCodexAgent(");
    expect(regenerated).toContain("codexTerra: new SmithersCodexAgent(");
    expect(regenerated).toContain("codexLuna: new SmithersCodexAgent(");
    expect(regenerated).toContain("claudeSonnet: new SmithersClaudeCodeAgent(");
    expect(uncommented(regenerated)).not.toContain("codex: CodexAgent");
    expect(uncommented(regenerated)).not.toContain("claude: ClaudeCodeAgent");
    expectCodexFirstDefaultTiers(regenerated, "codex");
  });

  test("preserves generated detection providers during account-driven rewrites", () => {
    const env = newSmithersHome();
    addAccount(
      { label: "codex-prod", provider: "codex", configDir: `${env.HOME}/.smithers/accounts/codex-prod` },
      { env },
    );
    const previous = [
      "// smithers-source: generated",
      "export const providers = {",
      '  claude: new SmithersClaudeCodeAgent({ model: "claude-fable-5", cwd: process.cwd() }),',
      '  claudeOpus: new SmithersClaudeCodeAgent({ model: "claude-opus-4-8", cwd: process.cwd() }),',
      '  claudeSonnet: new SmithersClaudeCodeAgent({ model: "claude-sonnet-5", cwd: process.cwd() }),',
      "} as const;",
      "",
    ].join("\n");
    const generated = generateAgentsTs(
      { ...env, PATH: "/no-agent-binaries" },
      {
        preserveProviderIds: extractGeneratedDetectionProviderIds(previous),
      },
    );
    expect(generated).toContain("claude: new SmithersClaudeCodeAgent(");
    expect(uncommented(generated)).not.toContain("cwd: process.cwd()");
    expect(generated).toContain("claudeOpus: new SmithersClaudeCodeAgent(");
    expect(generated).toContain("claudeSonnet: new SmithersClaudeCodeAgent(");
    expect(generated).toContain("codexProd: new SmithersCodexAgent(");
    expect(generated).toContain("codexProdSol: new SmithersCodexAgent(");
    expect(generated).toContain("codexProdTerra: new SmithersCodexAgent(");
    expect(generated).toContain("codexProdLuna: new SmithersCodexAgent(");
    expectCodexFirstDefaultTiers(generated, "codexProd");
  });

  test("no detected CLI binaries emits OpenRouter default and comments unavailable providers", () => {
    const env = newSmithersHome();
    const generated = generateAgentsTs({ ...env, PATH: "/no-agent-binaries", OPENROUTER_API_KEY: "" });
    const active = uncommented(generated);
    expect(generated).toContain('import { OpenAIAgent as SmithersOpenAIAgent } from "smithers-orchestrator";');
    expect(generated).toContain("openrouter: createOpenRouterAgent()");
    expect(generated).toContain("//   claude: new SmithersClaudeCodeAgent(");
    expect(generated).toContain('// import { CodexAgent as SmithersCodexAgent } from "smithers-orchestrator";');
    expect(generated).toContain('// export { CodexAgent } from "./agents/codex";');
    expect(generated).not.toMatch(/^\/\/ $/m);
    expect(active).toContain("smart: [\n    providers.openrouter,");
    expect(active).toContain("smartTool: [\n    providers.openrouter,");
    expect(active).toContain("review: [\n    providers.openrouter,");
    for (const tier of ALL_TIERS) {
      expect(activePoolProviders(generated, tier)).toEqual(["openrouter"]);
    }
    expect(active).not.toContain("providers.claude");
    expect(active).not.toContain("providers.codex");
  });

  test("generated detection id round-trip keeps OpenRouter default and commented providers stable", () => {
    const env = { ...newSmithersHome(), PATH: "/no-agent-binaries", OPENROUTER_API_KEY: "" };
    const initial = generateAgentsTs(env);
    const regenerated = generateAgentsTs(env, {
      preserveProviderIds: extractGeneratedDetectionProviderIds(initial),
    });
    expect([...extractGeneratedDetectionProviderIds(initial)]).toEqual(["openrouter"]);
    expect(regenerated).toBe(initial);
  });
});

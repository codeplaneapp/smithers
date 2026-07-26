import { spawnSync } from "node:child_process";
import { constants, accessSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { listAccounts } from "@smithers-orchestrator/accounts";
import { SOTA_DEPRECATED_MODELS, SOTA_SLOTS } from "./sota-models.generated.js";
/** @typedef {import("./AgentAvailability.ts").AgentAvailability} AgentAvailability */
/** @typedef {import("./AgentAvailabilityStatus.ts").AgentAvailabilityStatus} AgentAvailabilityStatus */

const DEFAULT_PROVIDER_ID = "openrouter";
const OPENROUTER_DEFAULT_MODEL = `openai/${SOTA_SLOTS.codexMini}`;

const DETECTORS = [
  {
    id: "claude",
    displayName: "Claude Code",
    binary: "claude",
    authSignals: (homeDir, env) => [
      join(env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(homeDir, ".claude"), ".credentials.json"),
      join(homeDir, ".claude.json"),
    ],
    apiKeys: [],
    availabilityProbe: (homeDir, env) => {
      const status = runProbeCommand("claude", ["auth", "status"], env);
      const parsed = parseJsonObject(status.stdout);
      if (parsed && parsed.loggedIn === true) {
        return passProbe("claude auth status reports logged in");
      }
      if (parsed && parsed.loggedIn === false) {
        return failProbe("claude auth status reports not logged in");
      }
      const configDir = env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(homeDir, ".claude");
      const credentials = readClaudeCredentials(configDir);
      if (credentials.valid) {
        return passProbe("Claude Code OAuth credentials are present");
      }
      if (status.ran && status.status !== 0) {
        return failProbe(status.output || "claude auth status failed");
      }
      return failProbe(credentials.reason ?? "Claude Code login not verified");
    },
    setupHint:
      "Install the Claude Code CLI and run `claude` then `/login`, or register an Anthropic API account with `smithers agents add`.",
  },
  {
    id: "codex",
    displayName: "Codex",
    binary: "codex",
    authSignals: (homeDir, env) => [
      join(env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(homeDir, ".codex"), "auth.json"),
    ],
    apiKeys: ["OPENAI_API_KEY"],
    availabilityProbe: (homeDir, env) => {
      if (env.OPENAI_API_KEY) {
        return env.OPENAI_API_KEY.startsWith("sk-")
          ? passProbe("OPENAI_API_KEY has expected format")
          : failProbe("OPENAI_API_KEY has unexpected format");
      }
      const status = runProbeCommand("codex", ["login", "status"], env);
      if (status.status === 0 && /logged in|api key|chatgpt/i.test(status.output)) {
        return passProbe("codex login status reports logged in");
      }
      const auth = readCodexAuth(homeDir, env);
      if (auth.valid) {
        return passProbe("Codex auth.json contains usable credentials");
      }
      return failProbe(status.output || auth.reason || "Codex login not verified");
    },
    setupHint: "Install the Codex CLI and run `codex login`, or set `OPENAI_API_KEY`.",
  },
  {
    id: DEFAULT_PROVIDER_ID,
    displayName: "OpenRouter",
    binary: "openrouter-api",
    requiresBinary: false,
    authSignals: () => [],
    apiKeys: ["OPENROUTER_API_KEY"],
    availabilityProbe: (_homeDir, env) =>
      env.OPENROUTER_API_KEY ? passProbe("$OPENROUTER_API_KEY is set") : failProbe("OPENROUTER_API_KEY is not set"),
    setupHint: "Set `OPENROUTER_API_KEY`, or run `smithers agent add` to configure another provider.",
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    binary: "opencode",
    authSignals: (homeDir) => [
      join(homeDir, ".local", "share", "opencode", "auth.json"),
      join(homeDir, ".config", "opencode"),
      join(homeDir, ".local", "share", "opencode"),
    ],
    apiKeys: ["OPENCODE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
    availabilityProbe: (homeDir, env) => {
      const key = detectorFirstEnv(env, [
        "OPENCODE_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
      ]);
      if (key) {
        return passProbe(`$${key} is set`);
      }
      const status = runProbeCommand("opencode", ["auth", "list"], env);
      if (status.status === 0 && hasPositiveOpenCodeAuthList(status.output)) {
        return passProbe("opencode auth list reports configured credentials");
      }
      const auth = readOpenCodeAuth(homeDir);
      if (auth.valid) {
        return passProbe("OpenCode auth file contains credentials");
      }
      return failProbe(status.output || auth.reason || "OpenCode credentials not verified");
    },
    setupHint: "Install the OpenCode CLI and run `opencode auth login`, or set a provider API key.",
  },
  {
    id: "antigravity",
    displayName: "Antigravity",
    binary: "agy",
    authSignals: (homeDir, env) => {
      const configRoot = env.GEMINI_DIR ? resolve(env.GEMINI_DIR) : join(homeDir, ".gemini");
      return [join(configRoot, "antigravity-cli", "settings.json"), join(configRoot, "antigravity-cli")];
    },
    apiKeys: [],
    availabilityProbe: (homeDir, env) => {
      const configRoot = env.GEMINI_DIR ? resolve(env.GEMINI_DIR) : join(homeDir, ".gemini");
      if (jsonFileHasContent(join(configRoot, "antigravity-cli", "settings.json"))) {
        return passProbe("Antigravity settings are present");
      }
      return failProbe("Antigravity settings are missing or empty");
    },
    setupHint: "Install the Antigravity CLI, run `agy`, and complete Google Sign-In.",
  },
  {
    id: "pi",
    displayName: "Pi",
    binary: "pi",
    authSignals: (homeDir) => [join(homeDir, ".pi", "agent", "auth.json")],
    apiKeys: [],
    availabilityProbe: (homeDir) => {
      const authPath = join(homeDir, ".pi", "agent", "auth.json");
      if (jsonFileHasContent(authPath)) {
        return passProbe("Pi auth.json contains credentials");
      }
      return failProbe("Pi auth.json is missing or empty");
    },
    setupHint: "Install and authenticate the `pi` CLI.",
  },
  {
    id: "omp",
    displayName: "Oh My Pi",
    binary: "omp",
    authSignals: (homeDir) => [join(homeDir, ".omp")],
    apiKeys: [],
    availabilityProbe: (_homeDir, env) => {
      const status = runProbeCommand("omp", ["--version"], env);
      return status.status === 0 && /omp\//i.test(status.output)
        ? passProbe("OMP CLI is installed and executable")
        : failProbe(status.output || "OMP version probe failed");
    },
    setupHint: "Install Oh My Pi and configure a provider in OMP.",
  },
  {
    id: "kimi",
    displayName: "Kimi",
    binary: "kimi",
    authSignals: (homeDir, env) => {
      const signals = [join(homeDir, ".kimi")];
      if (env.KIMI_SHARE_DIR) signals.push(resolve(env.KIMI_SHARE_DIR));
      return signals;
    },
    apiKeys: [],
    availabilityProbe: (homeDir, env) => {
      const shareDir = env.KIMI_SHARE_DIR ? resolve(env.KIMI_SHARE_DIR) : join(homeDir, ".kimi");
      const credentials = readKimiCredentials(shareDir);
      if (credentials.valid) {
        return passProbe("Kimi credentials are present");
      }
      return failProbe(credentials.reason ?? "Kimi credentials not verified");
    },
    setupHint: "Install the Kimi CLI and run `kimi login`.",
  },
  {
    id: "amp",
    displayName: "Amp",
    binary: "amp",
    authSignals: (homeDir) => [join(homeDir, ".amp")],
    apiKeys: [],
    availabilityProbe: (_homeDir, env) => {
      if (env.AMP_API_KEY) {
        return passProbe("$AMP_API_KEY is set");
      }
      const status = runProbeCommand("amp", ["usage"], env);
      if (status.status === 0 && /signed in|remaining|workspace/i.test(status.output)) {
        return passProbe("amp usage reports signed-in account");
      }
      return failProbe(status.output || "Amp login not verified");
    },
    setupHint: "Install and authenticate the `amp` CLI.",
  },
  {
    id: "vibe",
    displayName: "Vibe",
    binary: "vibe",
    authSignals: (homeDir, env) => {
      const vibeHome = env.VIBE_HOME ? resolve(env.VIBE_HOME) : join(homeDir, ".vibe");
      return [join(vibeHome, ".env"), join(vibeHome, "config.toml")];
    },
    apiKeys: ["MISTRAL_API_KEY"],
    availabilityProbe: (_homeDir, env) =>
      env.MISTRAL_API_KEY ? passProbe("$MISTRAL_API_KEY is set") : failProbe("$MISTRAL_API_KEY is not set"),
    setupHint: "Install the Vibe CLI and run `vibe --setup` to configure an API key, or set `MISTRAL_API_KEY`.",
  },
  {
    id: "hermes",
    displayName: "Hermes",
    binary: "hermes",
    authSignals: (homeDir) => [join(homeDir, ".hermes", "config.yaml"), join(homeDir, ".hermes")],
    apiKeys: [],
    availabilityProbe: (_homeDir, env) => {
      const status = runProbeCommand("hermes", ["status"], env);
      if (status.status === 0 && /✓ configured|✓ sk-|✓ exists|Provider:/i.test(status.output)) {
        return passProbe("hermes status reports configured provider credentials");
      }
      return failProbe(status.output || "Hermes credentials not verified");
    },
    setupHint: "Install the Hermes Agent CLI and run `hermes` to configure a provider.",
  },
  {
    id: "openclaw",
    displayName: "OpenClaw",
    binary: "openclaw",
    authSignals: (homeDir) => [join(homeDir, ".openclaw", "openclaw.json"), join(homeDir, ".openclaw")],
    apiKeys: [],
    availabilityProbe: (homeDir, env) => {
      const status = runProbeCommand("openclaw", ["status"], env);
      const output = status.output ?? "";
      // `configured`/`ready`/`running` also appear in onboarding text like
      // "No agent configured. Run `openclaw configure`", so reject the
      // negative markers before trusting a status-0 exit as a real runtime.
      const looksConfigured = /logged in|authenticated|ready|running|✓|configured/i.test(output);
      const looksUnconfigured = /not configured|no agent|run .*configure|onboarding/i.test(output);
      if (status.status === 0 && looksConfigured && !looksUnconfigured) {
        return passProbe("openclaw status reports a configured runtime");
      }
      if (jsonFileHasContent(join(homeDir, ".openclaw", "openclaw.json"))) {
        return passProbe("OpenClaw config is present");
      }
      return failProbe(output || "OpenClaw setup not verified");
    },
    setupHint: "Install OpenClaw and finish onboarding with `openclaw configure` or the first-run wizard.",
  },
  {
    id: "pool",
    displayName: "Pool",
    binary: "pool",
    authSignals: (homeDir) => [
      join(homeDir, ".config", "poolside", "settings.yaml"),
      join(homeDir, ".config", "poolside"),
    ],
    apiKeys: [],
    availabilityProbe: (_homeDir, env) => {
      const status = runProbeCommand("pool", ["--version"], env);
      if (status.status === 0 && /pool|v\d+\./.test(status.output)) {
        return passProbe("Pool CLI is installed and executable");
      }
      const settings = join(_homeDir, ".config", "poolside", "settings.yaml");
      if (existsSync(settings)) {
        return passProbe("Pool settings file is present");
      }
      return failProbe(status.output || "Pool CLI not verified");
    },
    setupHint: "Install the Pool CLI and run `pool login` to authenticate.",
  },
];
const ROLE_PREFERENCES = {
  spec: ["claude", "codex", "opencode", "pool", "openclaw"],
  research: ["codex", "kimi", "antigravity", "opencode", "pool", "claude", "openclaw"],
  plan: ["claude", "codex", "opencode", "pool", "antigravity", "kimi", "openclaw"],
  implement: ["codex", "opencode", "amp", "pool", "antigravity", "openclaw", "claude", "kimi"],
  validate: ["codex", "opencode", "amp", "pool", "antigravity", "openclaw", "claude", "kimi"],
  review: ["codex", "claude", "amp", "opencode", "pool", "openclaw", "kimi"],
};
const AGENT_VARIANTS = [
  {
    derivedFrom: "codex",
    variantId: "codexSol",
    displayName: "Codex Sol",
    constructor: {
      importName: "CodexAgent",
      expr: `new SmithersCodexAgent({ model: "${SOTA_SLOTS.codexSol}", config: { model_reasoning_effort: "xhigh" }, skipGitRepoCheck: true })`,
    },
  },
  {
    derivedFrom: "codex",
    variantId: "codexTerra",
    displayName: "Codex Terra",
    constructor: {
      importName: "CodexAgent",
      expr: `new SmithersCodexAgent({ model: "${SOTA_SLOTS.codexTerra}", config: { model_reasoning_effort: "medium" }, skipGitRepoCheck: true })`,
    },
  },
  {
    derivedFrom: "codex",
    variantId: "codexLuna",
    displayName: "Codex Luna",
    constructor: {
      importName: "CodexAgent",
      expr: `new SmithersCodexAgent({ model: "${SOTA_SLOTS.codex}", config: { model_reasoning_effort: "medium" }, skipGitRepoCheck: true })`,
    },
  },
  {
    derivedFrom: "claude",
    variantId: "claudeOpus",
    displayName: "Claude Opus",
    constructor: {
      importName: "ClaudeCodeAgent",
      expr: `new SmithersClaudeCodeAgent({ model: "${SOTA_SLOTS.opus}" })`,
    },
  },
  {
    derivedFrom: "claude",
    variantId: "claudeSonnet",
    displayName: "Claude Sonnet",
    constructor: {
      importName: "ClaudeCodeAgent",
      expr: `new SmithersClaudeCodeAgent({ model: "${SOTA_SLOTS.sonnet}" })`,
    },
  },
];
const SCAFFOLDED_PROVIDERS = {
  claude: "ClaudeCodeAgent",
  codex: "CodexAgent",
  opencode: "OpenCodeAgent",
  antigravity: "AntigravityAgent",
  pool: "PoolAgent",
};
const SCAFFOLDED_PROVIDER_FILES = {
  claude: "claude-code",
  codex: "codex",
  opencode: "opencode",
  antigravity: "antigravity",
  pool: "pool",
};
const LEGACY_SCAFFOLDED_PROVIDERS = {};
const LOCAL_SCAFFOLDED_PROVIDERS = {
  ...SCAFFOLDED_PROVIDERS,
  ...LEGACY_SCAFFOLDED_PROVIDERS,
};
const LOCAL_SCAFFOLDED_PROVIDER_FILES = {
  ...SCAFFOLDED_PROVIDER_FILES,
};
// Role routing. Claude Opus 5 leads the building and gating tiers: it is the
// default implementer (it beats GPT-5.6 Sol on agentic coding — Frontier-Bench
// 43.3% vs 34.4% — at lower output cost) and holds smart plus orchestrator
// decisions (scope, direction, progress, done-or-not); Fable (the base
// `claude` provider) plans. Codex keeps the checking tiers: Sol for review,
// Terra for validation and tool-heavy structured checking, and Luna (the base
// `codex` provider) only for trivial, minimal-risk cheap/research work.
// GPT-5.6 Sol/Terra are strong reviewers but poor gatekeepers, so in the
// Claude-led chains they appear only as availability fallbacks. Each chain's
// `order` is the chain order; the Codex block (detected variant + every
// registered Codex account) is inserted at the codexVariant's position in
// `order`. Later entries are dormant runtime fallbacks; a healthy earlier
// attempt completes the task before any fallback is invoked.
const TIER_PREFERENCES = {
  cheapFast: {
    codexVariant: "codexLuna",
    order: ["codexLuna", "claudeSonnet", "kimi", "vibe", "antigravity", "openclaw", "pi"],
    maxSize: 3,
  },
  research: {
    codexVariant: "codexLuna",
    order: ["codexLuna", "kimi", "antigravity", "opencode", "claudeSonnet", "openclaw", DEFAULT_PROVIDER_ID],
    maxSize: 3,
  },
  implement: {
    codexVariant: "codexTerra",
    order: [
      "claudeOpus",
      "codexTerra",
      "claudeSonnet",
      "kimi",
      "antigravity",
      "claude",
      "opencode",
      "openclaw",
      DEFAULT_PROVIDER_ID,
    ],
    maxSize: 3,
  },
  midTier: {
    codexVariant: "codexTerra",
    order: ["codexTerra", "claudeSonnet", "kimi", "antigravity", "opencode", "claude", "openclaw", DEFAULT_PROVIDER_ID],
    maxSize: 3,
  },
  smartTool: {
    codexVariant: "codexTerra",
    order: ["codexTerra", "claudeSonnet", "kimi", "antigravity", "opencode", "claude", "openclaw", DEFAULT_PROVIDER_ID],
    maxSize: 3,
  },
  validate: {
    codexVariant: "codexTerra",
    order: ["codexTerra", "claudeSonnet", "kimi", "antigravity", "opencode", "claude", "openclaw", DEFAULT_PROVIDER_ID],
    maxSize: 3,
  },
  smart: {
    codexVariant: "codexSol",
    order: [
      "claudeOpus",
      "claude",
      "codexSol",
      "opencode",
      "openclaw",
      DEFAULT_PROVIDER_ID,
      "antigravity",
      "amp",
      "kimi",
    ],
    maxSize: 3,
  },
  review: {
    codexVariant: "codexSol",
    order: [
      "codexSol",
      "claude",
      "claudeOpus",
      "claudeSonnet",
      "kimi",
      "amp",
      "opencode",
      "openclaw",
      DEFAULT_PROVIDER_ID,
    ],
    maxSize: 3,
  },
  planning: {
    codexVariant: "codexSol",
    order: ["claude", "claudeOpus", "codexSol", "claudeSonnet", "kimi", "opencode", "openclaw", DEFAULT_PROVIDER_ID],
    maxSize: 3,
  },
  orchestrator: {
    codexVariant: "codexSol",
    order: ["claudeOpus", "claude", "kimi", "codexSol", "opencode", "openclaw", DEFAULT_PROVIDER_ID],
    maxSize: 3,
  },
};
const REQUIRED_DEFAULT_TIERS = ["smart", "smartTool"];
const CONSTRUCTORS = {
  claude: {
    importName: "ClaudeCodeAgent",
    expr: `new SmithersClaudeCodeAgent({ model: "${SOTA_SLOTS.fable}" })`,
  },
  codex: {
    importName: "CodexAgent",
    expr: `new SmithersCodexAgent({ model: "${SOTA_SLOTS.codex}", config: { model_reasoning_effort: "medium" }, skipGitRepoCheck: true })`,
  },
  openrouter: {
    importName: "OpenAIAgent",
    expr: "createOpenRouterAgent()",
  },
  opencode: {
    importName: "OpenCodeAgent",
    expr: `new SmithersOpenCodeAgent({ model: "anthropic/${SOTA_SLOTS.fable}" })`,
  },
  antigravity: {
    importName: "AntigravityAgent",
    expr: "new SmithersAntigravityAgent()",
  },
  pi: {
    importName: "PiAgent",
    expr: `new SmithersPiAgent({ provider: "openai", model: "${SOTA_SLOTS.codex}" })`,
  },
  omp: {
    importName: "OmpAgent",
    expr: `new SmithersOmpAgent({ model: "${SOTA_SLOTS.codex}" })`,
  },
  kimi: {
    importName: "KimiAgent",
    expr: `new SmithersKimiAgent({ model: "${SOTA_SLOTS.kimi}" })`,
  },
  amp: {
    importName: "AmpAgent",
    expr: "new SmithersAmpAgent()",
  },
  vibe: {
    importName: "VibeAgent",
    expr: 'new SmithersVibeAgent({ agent: "auto-approve" })',
  },
  hermes: {
    importName: "HermesCliAgent",
    expr: "new SmithersHermesCliAgent()",
  },
  openclaw: {
    importName: "OpenClawAgent",
    expr: "new SmithersOpenClawAgent()",
  },
  pool: {
    importName: "PoolAgent",
    expr: "new SmithersPoolAgent()",
  },
};
/**
 * @param {string} id
 */
function detectorForId(id) {
  return DETECTORS.find((detector) => detector.id === id);
}

/**
 * @param {string} id
 */
function variantForId(id) {
  return AGENT_VARIANTS.find((variant) => variant.variantId === id);
}

/**
 * @param {string} id
 */
function baseAgentIdForProviderId(id) {
  return variantForId(id)?.derivedFrom ?? id;
}

/**
 * Extracts detection-derived provider ids from a generated `.smithers/agents.ts`.
 * Account labels are deliberately ignored; the accounts registry remains the
 * source of truth for account-backed providers.
 *
 * @param {string} source
 * @returns {Set<string>}
 */
export function extractGeneratedDetectionProviderIds(source) {
  const ids = new Set();
  if (!source.startsWith("// smithers-source: generated")) {
    return ids;
  }
  const providersMatch = source.match(/export const providers\s*=\s*{([\s\S]*?)}\s*as const;/);
  if (!providersMatch) {
    return ids;
  }
  for (const line of providersMatch[1].split("\n")) {
    const match = line.match(/^\s*([A-Za-z_$][\w$]*)\s*:\s*(.*?)\s*,?\s*$/);
    if (!match) continue;
    const [, providerId, initializer] = match;
    const scaffoldedProvider = SCAFFOLDED_PROVIDERS[providerId] ?? LEGACY_SCAFFOLDED_PROVIDERS[providerId];
    const constructorProvider = CONSTRUCTORS[providerId];
    if (
      (scaffoldedProvider && initializer === scaffoldedProvider) ||
      (constructorProvider && initializer === constructorProvider.expr)
    ) {
      ids.add(providerId);
      continue;
    }
    const variant = variantForId(providerId);
    if (variant && initializer === variant.constructor.expr) {
      ids.add(variant.derivedFrom);
    }
  }
  return ids;
}

/**
 * @param {string} id
 */
function displayNameForProviderId(id) {
  return variantForId(id)?.displayName ?? detectorForId(id)?.displayName ?? id;
}

/**
 * @param {string} binary
 * @param {NodeJS.ProcessEnv} env
 */
function commandExists(binary, env) {
  const pathEntries = env.PATH?.split(delimiter) ?? [];
  const extensions =
    process.platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  const candidates = /\.[^\\/]+$/.test(binary)
    ? [binary]
    : ["", ...extensions].map((ext) => `${binary}${ext.toLowerCase()}`);
  return pathEntries.some((entry) => {
    if (!entry) return false;
    for (const candidate of candidates) {
      try {
        accessSync(join(entry, candidate), constants.X_OK);
        return true;
      } catch {
        // keep looking
      }
    }
    return false;
  });
}

/**
 * @param {string} reason
 */
function passProbe(reason) {
  return { verified: true, reason };
}

/**
 * @param {string} reason
 */
function failProbe(reason) {
  return { verified: false, reason: sanitizeProbeOutput(reason) };
}

/**
 * Collapse probe output into one short human-readable reason. Probe commands
 * are arbitrary CLIs - some (Hermes) print full-screen TUI banners with ANSI
 * escapes and box-drawing borders, which would otherwise get dumped verbatim
 * into `unusableReasons` and wreck the init ceremony's agent list. Strip
 * escapes and border glyphs, keep the first lines with real content, and cap
 * the length.
 *
 * @param {string} value
 */
export function sanitizeProbeOutput(value) {
  const cleaned = value
    // ANSI CSI escape sequences (colors, cursor movement).
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    // OSC sequences (terminal titles), terminated by BEL or ST.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    // Box-drawing / block glyphs used by TUI banner borders.
    .replace(/[\u2500-\u257f\u2580-\u259f]/g, " ")
    // Remaining control chars except newline.
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
  const lines = cleaned
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    // A border row reduces to empty; require some word character so pure
    // punctuation rows are dropped too.
    .filter((line) => /\w/.test(line));
  const joined = lines.slice(0, 2).join("; ");
  return joined.length > 160 ? `${joined.slice(0, 157)}...` : joined;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} names
 */
function detectorFirstEnv(env, names) {
  return names.find((name) => Boolean(env[name]));
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
function runProbeCommand(command, args, env) {
  try {
    const result = spawnSync(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3_000,
      encoding: "utf8",
    });
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    return {
      ran: !result.error,
      status: result.status,
      stdout,
      stderr,
      output: sanitizeProbeOutput([stdout, stderr, result.error?.message ?? ""].filter(Boolean).join("\n")),
    };
  } catch (error) {
    return {
      ran: false,
      status: null,
      stdout: "",
      stderr: "",
      output: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * @param {string} raw
 * @returns {Record<string, unknown> | null}
 */
function parseJsonObject(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} path
 */
function readJsonObject(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 */
function hasNonEmptyStringDeep(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasNonEmptyStringDeep);
  return Object.values(value).some(hasNonEmptyStringDeep);
}

/**
 * @param {string} path
 */
function jsonFileHasContent(path) {
  const parsed = readJsonObject(path);
  return parsed ? Object.keys(parsed).length > 0 : false;
}

/**
 * @param {string} configDir
 */
function readClaudeCredentials(configDir) {
  const parsed = readJsonObject(join(configDir, ".credentials.json"));
  const oauth = parsed?.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") {
    return { valid: false, reason: "Claude Code OAuth credentials are missing" };
  }
  const accessToken = oauth.accessToken;
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    return { valid: false, reason: "Claude Code OAuth access token is missing" };
  }
  const expiresAt = oauth.expiresAt;
  if (typeof expiresAt === "number" && expiresAt <= Date.now()) {
    return { valid: false, reason: "Claude Code OAuth token is expired" };
  }
  return { valid: true };
}

/**
 * @param {string} homeDir
 * @param {NodeJS.ProcessEnv} env
 */
function readCodexAuth(homeDir, env) {
  const codexHome = env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(homeDir, ".codex");
  const parsed = readJsonObject(join(codexHome, "auth.json"));
  if (!parsed) {
    return { valid: false, reason: "Codex auth.json is missing or unreadable" };
  }
  if (typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.trim()) {
    return { valid: true };
  }
  if (typeof parsed.tokens?.access_token === "string" && parsed.tokens.access_token.trim()) {
    return { valid: true };
  }
  return { valid: false, reason: "Codex auth.json does not contain credentials" };
}

/**
 * @param {string} homeDir
 */
function readOpenCodeAuth(homeDir) {
  const parsed = readJsonObject(join(homeDir, ".local", "share", "opencode", "auth.json"));
  if (!parsed) {
    return { valid: false, reason: "OpenCode auth.json is missing or unreadable" };
  }
  return hasNonEmptyStringDeep(parsed)
    ? { valid: true }
    : { valid: false, reason: "OpenCode auth.json does not contain credentials" };
}

/**
 * @param {string} output
 */
function hasPositiveOpenCodeAuthList(output) {
  if (/\b[1-9]\d*\s+credentials?\b/i.test(output)) return true;
  return /logged in|authenticated|configured/i.test(output) && !/\b0\s+credentials?\b/i.test(output);
}

/**
 * @param {string} shareDir
 */
function readKimiCredentials(shareDir) {
  const credentialsDir = join(shareDir, "credentials");
  let entries;
  try {
    entries = readdirSync(credentialsDir);
  } catch {
    return { valid: false, reason: "Kimi credentials directory is missing" };
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const path = join(credentialsDir, entry);
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    const parsed = readJsonObject(path);
    if (!parsed) continue;
    const accessToken = parsed.access_token;
    const apiKey = parsed.api_key ?? parsed.apiKey;
    const expiresAt = parsed.expires_at;
    if (typeof apiKey === "string" && apiKey.trim()) return { valid: true };
    if (typeof accessToken === "string" && accessToken.trim()) {
      if (typeof expiresAt !== "number" || expiresAt > Math.floor(Date.now() / 1000)) {
        return { valid: true };
      }
    }
  }
  return { valid: false, reason: "Kimi credentials are missing or expired" };
}
/**
 * @param {boolean} hasBinary
 * @param {boolean} hasAuthSignal
 * @param {boolean} hasApiKeySignal
 * @returns {AgentAvailabilityStatus}
 */
function computeStatus(hasBinary, hasAuthSignal, hasApiKeySignal) {
  if (hasBinary && hasAuthSignal) return "likely-subscription";
  if (hasBinary && hasApiKeySignal) return "api-key";
  if (hasBinary) return "binary-only";
  if (hasAuthSignal) return "likely-subscription";
  if (hasApiKeySignal) return "api-key";
  return "unavailable";
}
/**
 * @param {AgentAvailabilityStatus} status
 */
function scoreStatus(status) {
  switch (status) {
    case "likely-subscription":
      return 4;
    case "api-key":
      return 3;
    case "binary-only":
      return 2;
    default:
      return 0;
  }
}

/**
 * @param {{ authSignals: (homeDir: string, env: NodeJS.ProcessEnv) => string[]; apiKeys: string[] }} detector
 * @param {string} homeDir
 * @param {NodeJS.ProcessEnv} env
 */
function credentialRequirementLabel(detector, homeDir, env) {
  const authSignals = detector.authSignals(homeDir, env);
  const pieces = [
    ...authSignals.map((signal) => signal.replace(homeDir, "~")),
    ...detector.apiKeys.map((name) => `$${name}`),
  ];
  return pieces.length > 0 ? pieces.join(" or ") : "agent credentials";
}

/**
 * @param {AgentAvailability} agent
 */
function formatUnusableReasons(agent) {
  return agent.unusableReasons.length > 0 ? agent.unusableReasons.join("; ") : "not enough availability signals";
}

/**
 * @param {AgentAvailability} agent
 */
export function describeUnavailableAgent(agent) {
  return `${agent.displayName} is unavailable: ${formatUnusableReasons(agent)}. ${
    agent.displayName === "Codex"
      ? "Recommended setup: install the Codex CLI, run `codex login`, then rerun `smithers init`."
      : "Smithers will use another available agent for this role."
  }`;
}

/**
 * @param {AgentAvailability[]} detections
 */
export function formatNoUsableAgentsMessage(detections) {
  const summaries = detections
    .map(
      (entry) =>
        `${entry.displayName}: ${entry.deprecated ? `deprecated (${entry.deprecationReason})` : entry.usable ? "usable" : formatUnusableReasons(entry)}`,
    )
    .join(" | ");
  return [
    `No usable agents detected. ${summaries}.`,
    `Checked: ${detections.flatMap((entry) => entry.checks).join(", ")}`,
    "Recommended setup: install the Codex CLI, run `codex login`, then rerun `smithers init`.",
    "If you use API billing, make sure `codex` is installed and set `OPENAI_API_KEY`.",
  ].join(" ");
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ cwd?: string }} [options]
 * @returns {AgentAvailability[]}
 */
export function detectAvailableAgents(env = process.env, options = {}) {
  const homeDir = env.HOME ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  return DETECTORS.map((detector) => {
    const authSignals = detector.authSignals(homeDir, env);
    const requiresBinary = detector.requiresBinary !== false;
    const hasBinary = requiresBinary ? commandExists(detector.binary, env) : false;
    const authSignalChecks = authSignals.map((signal) => ({
      signal,
      exists: existsSync(signal),
    }));
    const hasAuthSignal = authSignalChecks.some((check) => check.exists);
    const hasApiKeySignal = detector.apiKeys.some((name) => Boolean(env[name]));
    const projectTrust = detector.projectTrust?.(homeDir, env, cwd) ?? { trusted: true, checks: [] };
    const hasProjectTrustSignal = projectTrust.trusted;
    const availabilityProbe =
      hasBinary || !requiresBinary ? detector.availabilityProbe?.(homeDir, env, cwd) : undefined;
    const hasAvailabilityProbeSignal = availabilityProbe ? availabilityProbe.verified : true;
    const hasProbeCredentialSignal = availabilityProbe?.verified === true;
    const status = computeStatus(hasBinary, hasAuthSignal || hasProbeCredentialSignal, hasApiKeySignal);
    const hasCredentialSignal = hasAuthSignal || hasApiKeySignal || hasProbeCredentialSignal;
    const unusableReasons = [];
    if (requiresBinary && !hasBinary) {
      unusableReasons.push(`missing \`${detector.binary}\` on PATH`);
    }
    if (!hasCredentialSignal) {
      unusableReasons.push(`missing credentials (${credentialRequirementLabel(detector, homeDir, env)})`);
    }
    if (!hasProjectTrustSignal) {
      unusableReasons.push("current project is not trusted by Gemini");
    }
    if (!hasAvailabilityProbeSignal) {
      unusableReasons.push(
        availabilityProbe?.reason
          ? `availability check failed (${availabilityProbe.reason})`
          : "availability check failed",
      );
    }
    return {
      id: detector.id,
      displayName: detector.displayName,
      binary: detector.binary,
      deprecated: detector.deprecated === true ? true : undefined,
      deprecationReason: detector.deprecationReason,
      hasBinary,
      hasAuthSignal,
      hasApiKeySignal,
      hasProjectTrustSignal,
      status,
      score: scoreStatus(status),
      usable: unusableReasons.length === 0,
      checks: [
        `binary:${detector.binary}:${requiresBinary ? (hasBinary ? "yes" : "no") : "not-required"}`,
        ...authSignalChecks.map((check) => `auth:${check.signal}:${check.exists ? "yes" : "no"}`),
        ...detector.apiKeys.map((name) => `env:${name}:${env[name] ? "yes" : "no"}`),
        ...projectTrust.checks,
        ...(availabilityProbe
          ? [`probe:${detector.id}:${availabilityProbe.verified ? "yes" : "no"}:${availabilityProbe.reason}`]
          : []),
      ],
      unusableReasons,
    };
  });
}
/**
 * @param {AgentAvailability[]} available
 */
function fallbackAgents(available) {
  return [...available].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return (
      DETECTORS.findIndex((detector) => detector.id === left.id) -
      DETECTORS.findIndex((detector) => detector.id === right.id)
    );
  });
}
/**
 * @param {string} role
 * @param {AgentAvailability[]} available
 */
function resolveRoleAgents(role, available) {
  const preferred = ROLE_PREFERENCES[role] ?? [];
  const filtered = preferred.map((id) => available.find((entry) => entry.id === id)).filter((entry) => Boolean(entry));
  if (filtered.length > 0) return filtered;
  return fallbackAgents(available);
}
/**
 * Maps an account provider id to the SDK class name that constructs it.
 * @type {Record<string, string>}
 */
const ACCOUNT_PROVIDER_CLASSES = {
  "claude-code": "ClaudeCodeAgent",
  antigravity: "AntigravityAgent",
  codex: "CodexAgent",
  kimi: "KimiAgent",
  "anthropic-api": "ClaudeCodeAgent",
  "openai-api": "CodexAgent",
  "gemini-api": "OpenAIAgent",
};

/**
 * Family the account belongs to for pool grouping (e.g. anthropic-api and
 * claude-code both go in the `claude` pool).
 * @type {Record<string, string>}
 */
const ACCOUNT_PROVIDER_POOL = {
  "claude-code": "claude",
  "anthropic-api": "claude",
  antigravity: "antigravity",
  codex: "codex",
  "openai-api": "codex",
  "gemini-api": "gemini",
  kimi: "kimi",
};

/**
 * Default model per provider when an account doesn't specify one.
 * @type {Record<string, string>}
 */
const ACCOUNT_PROVIDER_DEFAULT_MODEL = {
  "claude-code": SOTA_SLOTS.fable,
  "anthropic-api": SOTA_SLOTS.fable,
  antigravity: undefined,
  codex: SOTA_SLOTS.codex,
  "openai-api": SOTA_SLOTS.codex,
  "gemini-api": SOTA_SLOTS.gemini,
  kimi: SOTA_SLOTS.kimi,
};

const CODEX_TIER_MODEL = {
  cheapFast: SOTA_SLOTS.codex,
  research: SOTA_SLOTS.codex,
  implement: SOTA_SLOTS.codexTerra,
  midTier: SOTA_SLOTS.codexTerra,
  smartTool: SOTA_SLOTS.codexTerra,
  validate: SOTA_SLOTS.codexTerra,
  smart: SOTA_SLOTS.codexSol,
  review: SOTA_SLOTS.codexSol,
  planning: SOTA_SLOTS.codexSol,
  orchestrator: SOTA_SLOTS.codexSol,
};

const CODEX_MODEL_SUFFIX = {
  [SOTA_SLOTS.codexSol]: "Sol",
  [SOTA_SLOTS.codexTerra]: "Terra",
  [SOTA_SLOTS.codex]: "Luna",
};

/** @param {import("@smithers-orchestrator/accounts").Account} account */
function isCodexAccount(account) {
  return ACCOUNT_PROVIDER_POOL[account.provider] === "codex";
}

/**
 * @param {import("@smithers-orchestrator/accounts").Account} account
 * @param {string} model
 */
function codexAccountVariantId(account, model) {
  return `${labelToCamel(account.label)}${CODEX_MODEL_SUFFIX[model]}`;
}

/**
 * @param {string} label
 * @returns {string}
 */
function labelToCamel(label) {
  return label
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part, i) => (i === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join("");
}

/**
 * Renders an absolute path as a JS expression. Paths under $HOME are rewritten
 * to `path.join(homedir(), ...)` so the generated agents.ts is portable across
 * machines (the registry stores absolute paths, but a checked-in agents.ts
 * shouldn't bake in /Users/<name>).
 *
 * @param {string} absPath
 * @param {string} homeDir
 * @returns {string}
 */
function pathLiteral(absPath, homeDir) {
  if (homeDir && absPath.startsWith(homeDir + "/")) {
    const rel = absPath.slice(homeDir.length + 1);
    return `path.join(homedir(), ${JSON.stringify(rel)})`;
  }
  if (absPath === homeDir) {
    return "homedir()";
  }
  return JSON.stringify(absPath);
}

/**
 * Renders an account as `<labelCamel>: new SmithersFooAgent({ ... })` for
 * inclusion in the providers map.
 *
 * @param {import("@smithers-orchestrator/accounts").Account} account
 * @param {string} homeDir
 * @returns {string}
 */
function renderAccountProviderLine(account, homeDir) {
  return renderAccountProviderVariantLine(account, homeDir, labelToCamel(account.label), undefined);
}

/**
 * Render one account-backed provider with an optional role-specific model.
 * Codex accounts receive Sol/Terra/Luna siblings so default pools can select
 * the right model without discarding the account's configDir or API key.
 *
 * @param {import("@smithers-orchestrator/accounts").Account} account
 * @param {string} homeDir
 * @param {string} providerId
 * @param {string | undefined} modelOverride
 * @returns {string}
 */
function renderAccountProviderVariantLine(account, homeDir, providerId, modelOverride) {
  const cls = ACCOUNT_PROVIDER_CLASSES[account.provider];
  const requestedModel = modelOverride ?? account.model ?? ACCOUNT_PROVIDER_DEFAULT_MODEL[account.provider];
  const model = requestedModel ? (SOTA_DEPRECATED_MODELS[requestedModel] ?? requestedModel) : undefined;
  /** @type {string[]} */
  const opts = [];
  if (model) opts.push(`model: ${JSON.stringify(model)}`);
  if (account.provider === "codex" || account.provider === "openai-api") {
    const reasoningEffort = model === SOTA_SLOTS.codexSol ? "xhigh" : "medium";
    opts.push(`config: { model_reasoning_effort: ${JSON.stringify(reasoningEffort)} }`);
  }
  if (account.configDir) opts.push(`configDir: ${pathLiteral(account.configDir, homeDir)}`);
  else if (account.apiKey) opts.push(`apiKey: ${JSON.stringify(account.apiKey)}`);
  if (account.provider === "codex" || account.provider === "openai-api") {
    opts.push("skipGitRepoCheck: true");
  }
  if (account.provider === "gemini-api") {
    opts.push('baseURL: "https://generativelanguage.googleapis.com/v1beta/openai"');
  }
  return `  ${providerId}: new Smithers${cls}({ ${opts.join(", ")} }),`;
}

/**
 * @param {import("@smithers-orchestrator/accounts").Account} account
 * @param {string} homeDir
 * @returns {string[]}
 */
function renderAccountProviderLines(account, homeDir) {
  const base = renderAccountProviderLine(account, homeDir);
  if (!isCodexAccount(account)) return [base];
  return [
    base,
    renderAccountProviderVariantLine(
      account,
      homeDir,
      codexAccountVariantId(account, SOTA_SLOTS.codexSol),
      SOTA_SLOTS.codexSol,
    ),
    renderAccountProviderVariantLine(
      account,
      homeDir,
      codexAccountVariantId(account, SOTA_SLOTS.codexTerra),
      SOTA_SLOTS.codexTerra,
    ),
    renderAccountProviderVariantLine(
      account,
      homeDir,
      codexAccountVariantId(account, SOTA_SLOTS.codex),
      SOTA_SLOTS.codex,
    ),
  ];
}

/**
 * @param {string} tier
 * @param {string[]} order
 * @param {Set<string>} allProviderIds
 * @param {Map<string, AgentAvailability>} detectionsById
 * @returns {string[]}
 */
function renderUnavailablePreferenceComments(tier, order, allProviderIds, detectionsById) {
  const firstAvailablePreferredIndex = order.findIndex((id) => allProviderIds.has(id));
  const cutoff = firstAvailablePreferredIndex === -1 ? order.length : firstAvailablePreferredIndex;
  const comments = [];
  for (const providerId of order.slice(0, cutoff)) {
    const baseId = baseAgentIdForProviderId(providerId);
    const detection = detectionsById.get(baseId);
    if (!detection || detection.usable) continue;
    comments.push(
      `  // ${tier}: Smithers would normally suggest ${displayNameForProviderId(providerId)} here, but ${detection.displayName} is not available: ${formatUnusableReasons(detection)}.`,
    );
  }
  return comments;
}

/**
 * @param {string} tier
 * @param {string[]} activeProviderIds
 * @param {string[]} commentedProviderIds
 * @param {string[]} comments
 */
function renderTierLine(tier, activeProviderIds, commentedProviderIds, comments) {
  return [
    ...comments,
    `  ${tier}: [`,
    ...activeProviderIds.map((id) => `    providers.${id},`),
    ...commentedProviderIds.map((id) => `    // providers.${id},`),
    `  ],`,
  ];
}

/**
 * @param {boolean} active
 * @param {string} line
 */
function commentIfInactive(active, line) {
  if (active) return line;
  return line ? `// ${line}` : "//";
}

/**
 * @param {string} providerId
 */
function canRenderProvider(providerId) {
  return providerId in CONSTRUCTORS;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {AgentAvailability}
 */
function createDefaultOpenRouterAvailability(env) {
  const detector = detectorForId(DEFAULT_PROVIDER_ID);
  const hasApiKeySignal = Boolean(env.OPENROUTER_API_KEY);
  return {
    id: DEFAULT_PROVIDER_ID,
    displayName: detector?.displayName ?? "OpenRouter",
    binary: detector?.binary ?? "openrouter-api",
    hasBinary: false,
    hasAuthSignal: false,
    hasApiKeySignal,
    hasProjectTrustSignal: true,
    status: hasApiKeySignal ? "api-key" : "unavailable",
    score: hasApiKeySignal ? scoreStatus("api-key") : scoreStatus("unavailable"),
    usable: true,
    checks: [
      "binary:openrouter-api:not-required",
      `env:OPENROUTER_API_KEY:${hasApiKeySignal ? "yes" : "no"}`,
      "fallback:openrouter:yes",
    ],
    unusableReasons: [],
  };
}

/**
 * @param {Set<string>} activeBaseIds
 * @param {import("@smithers-orchestrator/accounts").Account[]} registeredAccounts
 */
function requiredTiersHaveCandidates(activeBaseIds, registeredAccounts) {
  return REQUIRED_DEFAULT_TIERS.every((tier) => {
    const preference = TIER_PREFERENCES[tier];
    if (!preference) return true;
    const activeProviderIds = new Set(activeBaseIds);
    for (const variant of AGENT_VARIANTS) {
      if (activeBaseIds.has(variant.derivedFrom)) activeProviderIds.add(variant.variantId);
    }
    if (preference.order.some((id) => activeProviderIds.has(id))) return true;
    const tierFamilies = new Set(preference.order.map(baseAgentIdForProviderId));
    return registeredAccounts.some((account) => tierFamilies.has(ACCOUNT_PROVIDER_POOL[account.provider]));
  });
}

/**
 * @param {boolean} active
 * @returns {string[]}
 */
function renderOpenRouterHelper(active) {
  return [
    commentIfInactive(active, "class SmithersOpenRouterAgent extends SmithersOpenAIAgent {"),
    commentIfInactive(active, "  generate(args = {}) {"),
    commentIfInactive(active, "    if (!process.env.OPENROUTER_API_KEY) {"),
    commentIfInactive(
      active,
      '      throw new Error("Smithers generated an OpenRouter default agent, but OPENROUTER_API_KEY is not set. Set OPENROUTER_API_KEY, or run `smithers agent add` to configure another agent, then rerun this workflow.");',
    ),
    commentIfInactive(active, "    }"),
    commentIfInactive(active, "    return super.generate(args);"),
    commentIfInactive(active, "  }"),
    commentIfInactive(active, "}"),
    commentIfInactive(active, ""),
    commentIfInactive(active, "function createOpenRouterAgent() {"),
    commentIfInactive(active, "  return new SmithersOpenRouterAgent({"),
    commentIfInactive(active, `    model: ${JSON.stringify(OPENROUTER_DEFAULT_MODEL)},`),
    commentIfInactive(active, '    baseURL: "https://openrouter.ai/api/v1",'),
    commentIfInactive(active, "    apiKey: process.env.OPENROUTER_API_KEY,"),
    commentIfInactive(active, "  });"),
    commentIfInactive(active, "}"),
  ];
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ cwd?: string; preserveProviderIds?: Iterable<string>; scaffoldProviderIds?: Iterable<string> }} [options]
 */
export function generateAgentsTs(env = process.env, options = {}) {
  const registeredAccounts = listAccounts(env);
  const detections = detectAvailableAgents(env, options);
  const scaffoldProviderIds = new Set(options.scaffoldProviderIds ?? Object.keys(SCAFFOLDED_PROVIDERS));
  const hasLocalScaffold = (providerId) =>
    providerId in LOCAL_SCAFFOLDED_PROVIDERS && scaffoldProviderIds.has(providerId);
  const availableById = new Map(
    detections.filter((entry) => entry.usable && !entry.deprecated).map((entry) => [entry.id, entry]),
  );
  for (const providerId of options.preserveProviderIds ?? []) {
    const baseId = baseAgentIdForProviderId(providerId);
    const detector = detectorForId(baseId);
    if (!detector || availableById.has(baseId)) continue;
    availableById.set(baseId, {
      id: detector.id,
      displayName: detector.displayName,
      binary: detector.binary,
      hasBinary: false,
      hasAuthSignal: false,
      hasApiKeySignal: false,
      hasProjectTrustSignal: true,
      status: "likely-subscription",
      score: scoreStatus("likely-subscription"),
      usable: true,
      checks: [`preserved:${detector.id}:yes`],
      unusableReasons: [],
    });
  }
  if (!requiredTiersHaveCandidates(new Set(availableById.keys()), registeredAccounts)) {
    availableById.set(DEFAULT_PROVIDER_ID, createDefaultOpenRouterAvailability(env));
  }
  const providerStates = DETECTORS.filter((detector) => {
    if (canRenderProvider(detector.id)) return true;
    if (availableById.has(detector.id)) {
      console.warn(`agents.ts: skipping detected agent "${detector.id}" (no SDK constructor mapping yet).`);
    }
    return false;
  }).map((detector) => ({
    id: detector.id,
    active: availableById.has(detector.id),
  }));
  const activeProviderStates = providerStates.filter((entry) => entry.active);
  const activeBaseIds = new Set(activeProviderStates.map((entry) => entry.id));
  const variantStates = AGENT_VARIANTS.map((variant) => ({
    ...variant,
    active: activeBaseIds.has(variant.derivedFrom),
  }));
  // Smithers SDK class imports needed: active imports stay live; imports used
  // only by unavailable/commented provider lines are rendered as comments.
  const activeImportNames = new Set();
  const inactiveImportNames = new Set();
  for (const provider of providerStates) {
    const importName = CONSTRUCTORS[provider.id]?.importName;
    if (importName) (provider.active ? activeImportNames : inactiveImportNames).add(importName);
  }
  for (const variant of variantStates) {
    (variant.active ? activeImportNames : inactiveImportNames).add(variant.constructor.importName);
  }
  for (const account of registeredAccounts) {
    const cls = ACCOUNT_PROVIDER_CLASSES[account.provider];
    if (cls) activeImportNames.add(cls);
  }
  for (const importName of activeImportNames) {
    inactiveImportNames.delete(importName);
  }
  const smithersImportLines = [
    'import { type AgentLike } from "smithers-orchestrator";',
    ...[...activeImportNames].map(
      (importName) => `import { ${importName} as Smithers${importName} } from "smithers-orchestrator";`,
    ),
    ...[...inactiveImportNames].map(
      (importName) => `// import { ${importName} as Smithers${importName} } from "smithers-orchestrator";`,
    ),
  ];
  const homeDir = env.HOME ?? homedir();
  const hasAccounts = registeredAccounts.length > 0;
  // Provider lines: detection base + variants + accounts (additive — `agent
  // add` must never silently delete a previously-emitted provider). Base
  // providers deliberately use cwd-neutral SDK constructors instead of the
  // preserved user scaffold instances, so Task rootDir and <Worktree> remain
  // authoritative after re-init. The scaffold names are still re-exported
  // below for workflows that import them explicitly.
  const providerLines = [
    ...providerStates.map((provider) =>
      commentIfInactive(provider.active, `  ${provider.id}: ${CONSTRUCTORS[provider.id].expr},`),
    ),
    ...variantStates.map((variant) =>
      commentIfInactive(variant.active, `  ${variant.variantId}: ${variant.constructor.expr},`),
    ),
    ...registeredAccounts.flatMap((account) => renderAccountProviderLines(account, homeDir)),
  ];
  const scaffoldExportLines = providerStates
    .filter((provider) => hasLocalScaffold(provider.id))
    .map((provider) =>
      commentIfInactive(
        provider.active,
        `export { ${LOCAL_SCAFFOLDED_PROVIDERS[provider.id]} } from "./agents/${LOCAL_SCAFFOLDED_PROVIDER_FILES[provider.id]}";`,
      ),
    );
  const openRouterHelperLines = renderOpenRouterHelper(activeBaseIds.has(DEFAULT_PROVIDER_ID));
  // All known provider/variant IDs for tier resolution
  const allProviderIds = new Set([
    ...activeProviderStates.map((p) => p.id),
    ...variantStates.filter((v) => v.active).map((v) => v.variantId),
  ]);
  const codexAccounts = registeredAccounts.filter(isCodexAccount);
  const hasCodexDefaults = activeBaseIds.has("codex") || codexAccounts.length > 0;
  const detectionsById = new Map(detections.map((entry) => [entry.id, entry]));
  // Fallback: all base provider IDs sorted by score (for tiers with no preferred match)
  const fallbackIds = activeProviderStates.map((p) => p.id);
  /** @type {Map<string, string[]>} */
  const accountPoolMembers = new Map();
  for (const account of registeredAccounts) {
    const family = ACCOUNT_PROVIDER_POOL[account.provider];
    if (!family) continue;
    const arr = accountPoolMembers.get(family) ?? [];
    arr.push(labelToCamel(account.label));
    accountPoolMembers.set(family, arr);
  }
  const accountPoolLines = [...accountPoolMembers.entries()]
    .map(([family, members]) => renderTierLine(family, members, [], []))
    .flat();
  // Tier lines: detection-resolved members, then accounts whose engine
  // family is in the tier's preference order get appended.
  const resolvedTierLines = Object.entries(TIER_PREFERENCES).map(([tier, { codexVariant, order, maxSize }]) => {
    if (hasCodexDefaults) {
      const model = CODEX_TIER_MODEL[tier];
      const detected = allProviderIds.has(codexVariant) ? [codexVariant] : [];
      const accountVariants = codexAccounts.map((account) => codexAccountVariantId(account, model));
      // Never cap Codex accounts ahead of a provider-family boundary.
      // Every registered Codex credential must be exhausted before a
      // later fallback can run; maxSize limits non-Codex breadth only.
      const codexProviders = [...detected, ...accountVariants];
      const fallbackOrder = order.filter((id) => id !== codexVariant && baseAgentIdForProviderId(id) !== "codex");
      const fallbackFamilies = new Set(fallbackOrder.map(baseAgentIdForProviderId));
      const accountFallbacksByFamily = new Map();
      for (const account of registeredAccounts) {
        const family = ACCOUNT_PROVIDER_POOL[account.provider];
        if (isCodexAccount(account) || !family || !fallbackFamilies.has(family)) continue;
        const members = accountFallbacksByFamily.get(family) ?? [];
        members.push(labelToCamel(account.label));
        accountFallbacksByFamily.set(family, members);
      }
      // The Codex block sits at the codexVariant's position in `order`,
      // so Codex-led tiers (implement, validate, ...) start with Codex
      // while Claude-led tiers (orchestrator, planning) run Claude first
      // and keep Codex as an availability fallback only.
      const orderedMembers = [];
      const emittedAccountFamilies = new Set();
      let codexEmitted = false;
      for (const id of order) {
        if (id === codexVariant || baseAgentIdForProviderId(id) === "codex") {
          if (!codexEmitted) orderedMembers.push(...codexProviders.map((member) => ({ id: member, codex: true })));
          codexEmitted = true;
          continue;
        }
        if (allProviderIds.has(id)) orderedMembers.push({ id, codex: false });
        const family = baseAgentIdForProviderId(id);
        if (emittedAccountFamilies.has(family)) continue;
        emittedAccountFamilies.add(family);
        orderedMembers.push(
          ...(accountFallbacksByFamily.get(family) ?? []).map((member) => ({ id: member, codex: false })),
        );
      }
      if (!codexEmitted) orderedMembers.push(...codexProviders.map((member) => ({ id: member, codex: true })));
      const seenMembers = new Set();
      const members = [];
      let nonCodexCount = 0;
      for (const member of orderedMembers) {
        if (seenMembers.has(member.id)) continue;
        seenMembers.add(member.id);
        if (!member.codex) {
          if (nonCodexCount >= maxSize) continue;
          nonCodexCount += 1;
        }
        members.push(member.id);
      }
      const unavailableFallbacks = fallbackOrder.filter((id) => !allProviderIds.has(id));
      const leadComment =
        order[0] === codexVariant
          ? "  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails."
          : "  // Claude leads this seat (Codex 5.6 does not orchestrate or gate). Later entries, including Codex, are runtime fallbacks.";
      return renderTierLine(tier, members, unavailableFallbacks, [leadComment]);
    }
    let resolved = order.filter((id) => allProviderIds.has(id)).slice(0, maxSize);
    if (resolved.length === 0) {
      const fallbackPool =
        tier === "smart" || tier === "smartTool" ? fallbackIds.filter((id) => id !== "opencode") : fallbackIds;
      resolved = fallbackPool.slice(0, maxSize);
    }
    const tierFamilies = new Set(order.map(baseAgentIdForProviderId));
    const tierAccounts = registeredAccounts
      .filter((account) => tierFamilies.has(ACCOUNT_PROVIDER_POOL[account.provider]))
      .map((account) => labelToCamel(account.label));
    // The synthetic OpenRouter default (DEFAULT_PROVIDER_ID) is a keyless,
    // last-resort fallback whose generate() throws until OPENROUTER_API_KEY
    // is set. It must never LEAD a tier when a real detection or account can
    // serve it — otherwise a machine first initialized with no agents (which
    // preserves openrouter as active) that later runs `agent add` would put
    // the throwing default at attempt 1 ahead of the real paid account.
    // Demote it to the end so it is genuine failover, not the hot path.
    let merged = [...resolved, ...tierAccounts];
    if (merged.includes(DEFAULT_PROVIDER_ID) && merged.some((id) => id !== DEFAULT_PROVIDER_ID)) {
      merged = [...merged.filter((id) => id !== DEFAULT_PROVIDER_ID), DEFAULT_PROVIDER_ID];
    }
    const commented = order.filter((id) => !allProviderIds.has(id));
    return renderTierLine(
      tier,
      merged,
      commented,
      renderUnavailablePreferenceComments(tier, order, allProviderIds, detectionsById),
    );
  });
  const tierLines = [...accountPoolLines, ...resolvedTierLines.flat()];
  return [
    "// smithers-source: generated",
    ...(hasAccounts
      ? [
          "// Account providers (camelCase labels) come from ~/.smithers/accounts.json — managed via `smithers agent add|list|remove`.",
        ]
      : []),
    ...(hasAccounts ? ['import { homedir } from "node:os";', 'import path from "node:path";'] : []),
    ...smithersImportLines,
    "",
    ...scaffoldExportLines,
    ...(scaffoldExportLines.length ? [""] : []),
    ...openRouterHelperLines,
    "",
    "export const providers = {",
    ...providerLines,
    "} as const;",
    "",
    "export const agents = {",
    ...tierLines,
    "} as const satisfies Record<string, AgentLike[]>;",
    "",
  ].join("\n");
}

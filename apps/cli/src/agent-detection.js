import { spawnSync } from "node:child_process";
import { constants, accessSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { SmithersError } from "@smithers-orchestrator/errors";
import { listAccounts } from "@smithers-orchestrator/accounts";
/** @typedef {import("./AgentAvailability.ts").AgentAvailability} AgentAvailability */
/** @typedef {import("./AgentAvailabilityStatus.ts").AgentAvailabilityStatus} AgentAvailabilityStatus */

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
        setupHint: "Install the Claude Code CLI and run `claude` then `/login`, or register an Anthropic API account with `smithers agents add`.",
    },
    {
        id: "codex",
        displayName: "Codex",
        binary: "codex",
        authSignals: (homeDir, env) => [join(env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(homeDir, ".codex"), "auth.json")],
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
            const key = detectorFirstEnv(env, ["OPENCODE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]);
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
            return [
                join(configRoot, "antigravity-cli", "settings.json"),
                join(configRoot, "antigravity-cli"),
            ];
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
        id: "kimi",
        displayName: "Kimi",
        binary: "kimi",
        authSignals: (homeDir, env) => {
            const signals = [join(homeDir, ".kimi")];
            if (env.KIMI_SHARE_DIR)
                signals.push(resolve(env.KIMI_SHARE_DIR));
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
            return [
                join(vibeHome, ".env"),
                join(vibeHome, "config.toml"),
            ];
        },
        apiKeys: ["MISTRAL_API_KEY"],
        availabilityProbe: (_homeDir, env) => env.MISTRAL_API_KEY
            ? passProbe("$MISTRAL_API_KEY is set")
            : failProbe("$MISTRAL_API_KEY is not set"),
        setupHint: "Install the Vibe CLI and run `vibe --setup` to configure an API key, or set `MISTRAL_API_KEY`.",
    },
    {
        id: "hermes",
        displayName: "Hermes",
        binary: "hermes",
        authSignals: (homeDir) => [
            join(homeDir, ".hermes", "config.yaml"),
            join(homeDir, ".hermes"),
        ],
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
];
const ROLE_PREFERENCES = {
    spec: ["claude", "codex", "opencode"],
    research: ["antigravity", "kimi", "opencode", "codex", "claude"],
    plan: ["claude", "codex", "opencode", "antigravity", "kimi"],
    implement: ["codex", "opencode", "amp", "antigravity", "claude", "kimi"],
    validate: ["codex", "opencode", "amp", "antigravity"],
    review: ["claude", "amp", "codex", "opencode"],
};
const AGENT_VARIANTS = [
    {
        derivedFrom: "claude",
        variantId: "claudeOpus",
        displayName: "Claude Opus",
        constructor: {
            importName: "ClaudeCodeAgent",
            expr: 'new SmithersClaudeCodeAgent({ model: "claude-opus-4-8", cwd: process.cwd() })',
        },
    },
    {
        derivedFrom: "claude",
        variantId: "claudeSonnet",
        displayName: "Claude Sonnet",
        constructor: {
            importName: "ClaudeCodeAgent",
            expr: 'new SmithersClaudeCodeAgent({ model: "claude-sonnet-4-6", cwd: process.cwd() })',
        },
    },
];
const SCAFFOLDED_PROVIDERS = {
    claude: "ClaudeCodeAgent",
    codex: "CodexAgent",
    opencode: "OpenCodeAgent",
    antigravity: "AntigravityAgent",
};
const SCAFFOLDED_PROVIDER_FILES = {
    claude: "claude-code",
    codex: "codex",
    opencode: "opencode",
    antigravity: "antigravity",
};
const LEGACY_SCAFFOLDED_PROVIDERS = {};
const LOCAL_SCAFFOLDED_PROVIDERS = {
    ...SCAFFOLDED_PROVIDERS,
    ...LEGACY_SCAFFOLDED_PROVIDERS,
};
const LOCAL_SCAFFOLDED_PROVIDER_FILES = {
    ...SCAFFOLDED_PROVIDER_FILES,
};
const TIER_PREFERENCES = {
    cheapFast: { order: ["claudeSonnet", "kimi", "vibe", "antigravity", "pi"], maxSize: 2 },
    smart: { order: ["claude", "claudeOpus", "codex", "kimi", "antigravity", "amp"], maxSize: 3 },
    smartTool: { order: ["claude", "claudeOpus", "codex", "kimi", "antigravity", "amp"], maxSize: 3 },
};
const REQUIRED_DEFAULT_TIERS = ["smart", "smartTool"];
const CONSTRUCTORS = {
    claude: {
        importName: "ClaudeCodeAgent",
        expr: 'new SmithersClaudeCodeAgent({ model: "claude-fable-5", cwd: process.cwd() })',
    },
    codex: {
        importName: "CodexAgent",
        expr: 'new SmithersCodexAgent({ model: "gpt-5.5", cwd: process.cwd(), skipGitRepoCheck: true })',
    },
    opencode: {
        importName: "OpenCodeAgent",
        expr: 'new SmithersOpenCodeAgent({ model: "anthropic/claude-fable-5", cwd: process.cwd() })',
    },
    antigravity: {
        importName: "AntigravityAgent",
        expr: "new SmithersAntigravityAgent({ cwd: process.cwd() })",
    },
    pi: {
        importName: "PiAgent",
        expr: 'new SmithersPiAgent({ provider: "openai", model: "gpt-5.5" })',
    },
    kimi: {
        importName: "KimiAgent",
        expr: 'new SmithersKimiAgent({ model: "kimi-k2.6" })',
    },
    amp: {
        importName: "AmpAgent",
        expr: "new SmithersAmpAgent()",
    },
    vibe: {
        importName: "VibeAgent",
        expr: 'new SmithersVibeAgent({ agent: "auto-approve", cwd: process.cwd() })',
    },
    hermes: {
        importName: "HermesCliAgent",
        expr: "new SmithersHermesCliAgent({ cwd: process.cwd() })",
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
        if (!match)
            continue;
        const [, providerId, initializer] = match;
        const scaffoldedProvider = SCAFFOLDED_PROVIDERS[providerId] ?? LEGACY_SCAFFOLDED_PROVIDERS[providerId];
        const constructorProvider = CONSTRUCTORS[providerId];
        if ((scaffoldedProvider && initializer === scaffoldedProvider) ||
            (constructorProvider && initializer === constructorProvider.expr)) {
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
    const extensions = process.platform === "win32"
        ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
        : [""];
    const candidates = /\.[^\\/]+$/.test(binary)
        ? [binary]
        : ["", ...extensions].map((ext) => `${binary}${ext.toLowerCase()}`);
    return pathEntries.some((entry) => {
        if (!entry)
            return false;
        for (const candidate of candidates) {
            try {
                accessSync(join(entry, candidate), constants.X_OK);
                return true;
            }
            catch {
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
    return { verified: false, reason: oneLine(reason) };
}

/**
 * @param {string} value
 */
function oneLine(value) {
    return value.trim().split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 2).join("; ");
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
            output: oneLine([stdout, stderr, result.error?.message ?? ""].filter(Boolean).join("\n")),
        };
    }
    catch (error) {
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
    }
    catch {
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
    }
    catch {
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
    }
    catch {
        return { valid: false, reason: "Kimi credentials directory is missing" };
    }
    for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const path = join(credentialsDir, entry);
        try {
            if (!statSync(path).isFile()) continue;
        }
        catch {
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
    if (hasBinary && hasAuthSignal)
        return "likely-subscription";
    if (hasBinary && hasApiKeySignal)
        return "api-key";
    if (hasBinary)
        return "binary-only";
    if (hasAuthSignal)
        return "likely-subscription";
    if (hasApiKeySignal)
        return "api-key";
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
    return agent.unusableReasons.length > 0
        ? agent.unusableReasons.join("; ")
        : "not enough availability signals";
}

/**
 * @param {AgentAvailability} agent
 */
export function describeUnavailableAgent(agent) {
    return `${agent.displayName} is unavailable: ${formatUnusableReasons(agent)}. ${agent.displayName === "Codex"
        ? "Recommended setup: install the Codex CLI, run `codex login`, then rerun `smithers init`."
        : "Smithers will use another available agent for this role."}`;
}

/**
 * @param {AgentAvailability[]} detections
 */
export function formatNoUsableAgentsMessage(detections) {
    const summaries = detections
        .map((entry) => `${entry.displayName}: ${entry.deprecated ? `deprecated (${entry.deprecationReason})` : entry.usable ? "usable" : formatUnusableReasons(entry)}`)
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
        const hasBinary = commandExists(detector.binary, env);
        const authSignalChecks = authSignals.map((signal) => ({
            signal,
            exists: existsSync(signal),
        }));
        const hasAuthSignal = authSignalChecks.some((check) => check.exists);
        const hasApiKeySignal = detector.apiKeys.some((name) => Boolean(env[name]));
        const projectTrust = detector.projectTrust?.(homeDir, env, cwd) ?? { trusted: true, checks: [] };
        const hasProjectTrustSignal = projectTrust.trusted;
        const availabilityProbe = hasBinary
            ? detector.availabilityProbe?.(homeDir, env, cwd)
            : undefined;
        const hasAvailabilityProbeSignal = availabilityProbe ? availabilityProbe.verified : true;
        const hasProbeCredentialSignal = availabilityProbe?.verified === true;
        const status = computeStatus(hasBinary, hasAuthSignal || hasProbeCredentialSignal, hasApiKeySignal);
        const hasCredentialSignal = hasAuthSignal || hasApiKeySignal || hasProbeCredentialSignal;
        const unusableReasons = [];
        if (!hasBinary) {
            unusableReasons.push(`missing \`${detector.binary}\` on PATH`);
        }
        if (!hasCredentialSignal) {
            unusableReasons.push(`missing credentials (${credentialRequirementLabel(detector, homeDir, env)})`);
        }
        if (!hasProjectTrustSignal) {
            unusableReasons.push("current project is not trusted by Gemini");
        }
        if (!hasAvailabilityProbeSignal) {
            unusableReasons.push(availabilityProbe?.reason
                ? `availability check failed (${availabilityProbe.reason})`
                : "availability check failed");
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
                `binary:${detector.binary}:${hasBinary ? "yes" : "no"}`,
                ...authSignalChecks.map((check) => `auth:${check.signal}:${check.exists ? "yes" : "no"}`),
                ...detector.apiKeys.map((name) => `env:${name}:${env[name] ? "yes" : "no"}`),
                ...projectTrust.checks,
                ...(availabilityProbe ? [`probe:${detector.id}:${availabilityProbe.verified ? "yes" : "no"}:${availabilityProbe.reason}`] : []),
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
        if (right.score !== left.score)
            return right.score - left.score;
        return DETECTORS.findIndex((detector) => detector.id === left.id) -
            DETECTORS.findIndex((detector) => detector.id === right.id);
    });
}
/**
 * @param {string} role
 * @param {AgentAvailability[]} available
 */
function resolveRoleAgents(role, available) {
    const preferred = ROLE_PREFERENCES[role] ?? [];
    const filtered = preferred
        .map((id) => available.find((entry) => entry.id === id))
        .filter((entry) => Boolean(entry));
    if (filtered.length > 0)
        return filtered;
    return fallbackAgents(available);
}
/**
 * Maps an account provider id to the SDK class name that constructs it.
 * @type {Record<string, string>}
 */
const ACCOUNT_PROVIDER_CLASSES = {
    "claude-code": "ClaudeCodeAgent",
    "antigravity": "AntigravityAgent",
    "codex": "CodexAgent",
    "kimi": "KimiAgent",
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
    "antigravity": "antigravity",
    "codex": "codex",
    "openai-api": "codex",
    "gemini-api": "gemini",
    "kimi": "kimi",
};

/**
 * Default model per provider when an account doesn't specify one.
 * @type {Record<string, string>}
 */
const ACCOUNT_PROVIDER_DEFAULT_MODEL = {
    "claude-code": "claude-fable-5",
    "anthropic-api": "claude-fable-5",
    "antigravity": undefined,
    "codex": "gpt-5.5",
    "openai-api": "gpt-5.5",
    "gemini-api": "gemini-3.1-pro-preview",
    "kimi": "kimi-k2.6",
};

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
 * Generates an agents.ts file driven by ~/.smithers/accounts.json. One
 * `providers.<labelCamel>` entry is emitted per registered account; pools
 * group accounts by engine family.
 *
 * @param {import("@smithers-orchestrator/accounts").Account[]} accounts
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function generateAccountsAgentsTs(accounts, env) {
    const homeDir = env.HOME ?? homedir();
    /** @type {Set<string>} */
    const importNames = new Set();
    for (const account of accounts) {
        const cls = ACCOUNT_PROVIDER_CLASSES[account.provider];
        if (cls) importNames.add(cls);
    }
    const smithersImportSpecifiers = [
        "type AgentLike",
        ...[...importNames].map((n) => `${n} as Smithers${n}`),
    ];
    const providerLines = accounts.map((account) => renderAccountProviderLine(account, homeDir));
    /** @type {Map<string, string[]>} */
    const poolMembers = new Map();
    for (const account of accounts) {
        const family = ACCOUNT_PROVIDER_POOL[account.provider];
        if (!family) continue;
        const arr = poolMembers.get(family) ?? [];
        arr.push(labelToCamel(account.label));
        poolMembers.set(family, arr);
    }
    const poolLines = [...poolMembers.entries()].map(([family, members]) =>
        `  ${family}: [${members.map((m) => `providers.${m}`).join(", ")}],`,
    );
    const allLabels = accounts.map((a) => labelToCamel(a.label));
    const membersForFamilies = (...families) => {
        const seen = new Set();
        const members = [];
        for (const family of families) {
            for (const member of poolMembers.get(family) ?? []) {
                if (seen.has(member)) continue;
                seen.add(member);
                members.push(member);
            }
        }
        for (const member of allLabels) {
            if (seen.has(member)) continue;
            seen.add(member);
            members.push(member);
        }
        return members;
    };
    poolLines.push(`  smart: [${membersForFamilies("claude", "codex").map((m) => `providers.${m}`).join(", ")}],`);
    poolLines.push(`  smartTool: [${membersForFamilies("claude", "codex").map((m) => `providers.${m}`).join(", ")}],`);
    poolLines.push(`  cheapFast: [${membersForFamilies("kimi", "antigravity", "codex", "claude").slice(0, 2).map((m) => `providers.${m}`).join(", ")}],`);
    return [
        "// smithers-source: generated",
        "// Source of truth: ~/.smithers/accounts.json (managed via `smithers agent add|list|remove`)",
        'import { homedir } from "node:os";',
        'import path from "node:path";',
        `import { ${smithersImportSpecifiers.join(", ")} } from "smithers-orchestrator";`,
        "",
        "export const providers = {",
        ...providerLines,
        "} as const;",
        "",
        "export const agents = {",
        ...poolLines,
        "} as const satisfies Record<string, AgentLike[]>;",
        "",
    ].join("\n");
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
    const cls = ACCOUNT_PROVIDER_CLASSES[account.provider];
    const camel = labelToCamel(account.label);
    const model = account.model ?? ACCOUNT_PROVIDER_DEFAULT_MODEL[account.provider];
    /** @type {string[]} */
    const opts = [];
    if (model) opts.push(`model: ${JSON.stringify(model)}`);
    if (account.configDir) opts.push(`configDir: ${pathLiteral(account.configDir, homeDir)}`);
    else if (account.apiKey) opts.push(`apiKey: ${JSON.stringify(account.apiKey)}`);
    if (account.provider === "codex" || account.provider === "openai-api") {
        opts.push("skipGitRepoCheck: true");
    }
    if (account.provider === "gemini-api") {
        opts.push('baseURL: "https://generativelanguage.googleapis.com/v1beta/openai"');
    }
    opts.push("cwd: process.cwd()");
    return `  ${camel}: new Smithers${cls}({ ${opts.join(", ")} }),`;
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
        comments.push(`  // ${tier}: Smithers would normally suggest ${displayNameForProviderId(providerId)} here, but ${detection.displayName} is not available: ${formatUnusableReasons(detection)}.`);
    }
    return comments;
}

/**
 * @param {string} tier
 * @param {string[]} providerIds
 * @param {string[]} comments
 */
function renderTierLine(tier, providerIds, comments) {
    return [
        ...comments,
        `  ${tier}: [${providerIds.map((id) => `providers.${id}`).join(", ")}],`,
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
    const usesLocalScaffold = (providerId) => providerId in LOCAL_SCAFFOLDED_PROVIDERS && scaffoldProviderIds.has(providerId);
    const availableById = new Map(detections.filter((entry) => entry.usable && !entry.deprecated).map((entry) => [entry.id, entry]));
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
    const available = [...availableById.values()];
    if (available.length === 0 && registeredAccounts.length === 0) {
        throw new SmithersError("NO_USABLE_AGENTS", formatNoUsableAgentsMessage(detections));
    }
    // When no agents are detected (e.g. fresh machine with only API keys
    // registered via `smithers agent add`), emit the accounts-only shape with
    // engine-family pools — there's no detection-derived base to merge into.
    if (available.length === 0) {
        return generateAccountsAgentsTs(registeredAccounts, env);
    }
    // Base providers in detection order. Never let a detected provider we
    // can't render (no local scaffold and no SDK constructor mapping) crash
    // agents.ts generation with an opaque `CONSTRUCTORS[...].importName` error —
    // skip it with a warning instead. This keeps `smithers init` working even
    // when a newer detector ships before its constructor mapping.
    const orderedProviders = DETECTORS
        .map((detector) => availableById.get(detector.id))
        .filter((entry) => Boolean(entry))
        .filter((entry) => {
            if (usesLocalScaffold(entry.id) || CONSTRUCTORS[entry.id]) return true;
            console.warn(
                `agents.ts: skipping detected agent "${entry.id}" (no SDK constructor mapping yet).`,
            );
            return false;
        });
    // Derive variants (e.g. claudeSonnet from claude)
    const availableIds = new Set(orderedProviders.map((p) => p.id));
    const activeVariants = AGENT_VARIANTS.filter((v) => availableIds.has(v.derivedFrom));
    // Smithers SDK class imports needed: detection variants + non-scaffolded
    // detection providers + every account class.
    const importNames = new Set();
    for (const provider of orderedProviders) {
        if (!usesLocalScaffold(provider.id)) {
            importNames.add(CONSTRUCTORS[provider.id].importName);
        }
    }
    for (const variant of activeVariants)
        importNames.add(variant.constructor.importName);
    for (const account of registeredAccounts) {
        const cls = ACCOUNT_PROVIDER_CLASSES[account.provider];
        if (cls) importNames.add(cls);
    }
    const smithersImportSpecifiers = [
        "type AgentLike",
        ...[...importNames].map((importName) => `${importName} as Smithers${importName}`),
    ];
    const homeDir = env.HOME ?? homedir();
    const hasAccounts = registeredAccounts.length > 0;
    // Provider lines: detection base + variants + accounts (additive — `agent
    // add` must never silently delete a previously-emitted provider).
    const providerLines = [
        ...orderedProviders.map((provider) => `  ${provider.id}: ${usesLocalScaffold(provider.id) ? LOCAL_SCAFFOLDED_PROVIDERS[provider.id] : CONSTRUCTORS[provider.id].expr},`),
        ...activeVariants.map((variant) => `  ${variant.variantId}: ${variant.constructor.expr},`),
        ...registeredAccounts.map((account) => renderAccountProviderLine(account, homeDir)),
    ];
    const scaffoldImportLines = orderedProviders
        .filter((provider) => usesLocalScaffold(provider.id))
        .map((provider) => `import { ${LOCAL_SCAFFOLDED_PROVIDERS[provider.id]} } from "./agents/${LOCAL_SCAFFOLDED_PROVIDER_FILES[provider.id]}";`);
    const scaffoldExportLines = orderedProviders
        .filter((provider) => usesLocalScaffold(provider.id))
        .map((provider) => `export { ${LOCAL_SCAFFOLDED_PROVIDERS[provider.id]} } from "./agents/${LOCAL_SCAFFOLDED_PROVIDER_FILES[provider.id]}";`);
    // All known provider/variant IDs for tier resolution
    const allProviderIds = new Set([
        ...orderedProviders.map((p) => p.id),
        ...activeVariants.map((v) => v.variantId),
    ]);
    const detectionsById = new Map(detections.map((entry) => [entry.id, entry]));
    // Fallback: all base provider IDs sorted by score (for tiers with no preferred match)
    const fallbackIds = orderedProviders.map((p) => p.id);
    // Tier lines: detection-resolved members, then accounts whose engine
    // family is in the tier's preference order get appended.
    const resolvedTiers = Object.entries(TIER_PREFERENCES).map(([tier, { order, maxSize }]) => {
        let resolved = order
            .filter((id) => allProviderIds.has(id))
            .slice(0, maxSize);
        if (resolved.length === 0) {
            const fallbackPool = tier === "smart" || tier === "smartTool"
                ? fallbackIds.filter((id) => id !== "opencode")
                : fallbackIds;
            resolved = fallbackPool.slice(0, maxSize);
        }
        const tierFamilies = new Set(order);
        const tierAccounts = registeredAccounts
            .filter((account) => tierFamilies.has(ACCOUNT_PROVIDER_POOL[account.provider]))
            .map((account) => labelToCamel(account.label));
        const merged = [...resolved, ...tierAccounts];
        return {
            tier,
            members: merged,
            lines: renderTierLine(
                tier,
                merged,
                renderUnavailablePreferenceComments(tier, order, allProviderIds, detectionsById),
            ),
        };
    });
    const missingRequiredTiers = REQUIRED_DEFAULT_TIERS.filter((tier) => {
        const resolved = resolvedTiers.find((entry) => entry.tier === tier);
        return !resolved || resolved.members.length === 0;
    });
    if (missingRequiredTiers.length > 0) {
        throw new SmithersError(
            "NO_USABLE_AGENTS",
            `${formatNoUsableAgentsMessage(detections)} Detected agents cannot populate required default pools: ${missingRequiredTiers.join(", ")}.`,
        );
    }
    const tierLines = resolvedTiers.flatMap((entry) => entry.lines);
    return [
        "// smithers-source: generated",
        ...(hasAccounts ? ["// Account providers (camelCase labels) come from ~/.smithers/accounts.json — managed via `smithers agent add|list|remove`."] : []),
        ...(hasAccounts ? ['import { homedir } from "node:os";', 'import path from "node:path";'] : []),
        `import { ${smithersImportSpecifiers.join(", ")} } from "smithers-orchestrator";`,
        ...scaffoldImportLines,
        "",
        ...scaffoldExportLines,
        ...(scaffoldExportLines.length ? [""] : []),
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

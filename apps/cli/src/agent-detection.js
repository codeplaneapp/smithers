import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { SmithersError } from "@smithers-orchestrator/errors";
import { listAccounts } from "@smithers-orchestrator/accounts";
/** @typedef {import("./AgentAvailability.ts").AgentAvailability} AgentAvailability */
/** @typedef {import("./AgentAvailabilityStatus.ts").AgentAvailabilityStatus} AgentAvailabilityStatus */

const DETECTORS = [
    {
        id: "claude",
        displayName: "Claude Code",
        binary: "claude",
        authSignals: (homeDir) => [
            join(homeDir, ".claude", ".credentials.json"),
            join(homeDir, ".claude.json"),
        ],
        apiKeys: ["ANTHROPIC_API_KEY"],
        setupHint: "Install the Claude Code CLI and run `claude` then `/login`, or set `ANTHROPIC_API_KEY`.",
    },
    {
        id: "codex",
        displayName: "Codex",
        binary: "codex",
        authSignals: (homeDir) => [join(homeDir, ".codex", "auth.json")],
        apiKeys: ["OPENAI_API_KEY"],
        setupHint: "Install the Codex CLI and run `codex login`, or set `OPENAI_API_KEY`.",
    },
    {
        id: "gemini",
        displayName: "Gemini",
        binary: "gemini",
        authSignals: (homeDir, env) => {
            const configDir = env.GEMINI_DIR ? resolve(env.GEMINI_DIR) : join(homeDir, ".gemini");
            return [
                join(configDir, "oauth_creds.json"),
                join(configDir, "google_accounts.json"),
            ];
        },
        apiKeys: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
        projectTrust: (homeDir, env, cwd) => {
            const configDir = env.GEMINI_DIR ? resolve(env.GEMINI_DIR) : join(homeDir, ".gemini");
            const trustFile = join(configDir, "trustedFolders.json");
            return readGeminiProjectTrust(trustFile, cwd);
        },
        setupHint: "Install the Gemini CLI, authenticate it, and trust this project with Gemini, or set `GEMINI_API_KEY` after installing the CLI.",
    },
    {
        id: "pi",
        displayName: "Pi",
        binary: "pi",
        authSignals: (homeDir) => [join(homeDir, ".pi", "agent", "auth.json")],
        apiKeys: [],
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
        setupHint: "Install the Kimi CLI and run `kimi login`.",
    },
    {
        id: "amp",
        displayName: "Amp",
        binary: "amp",
        authSignals: (homeDir) => [join(homeDir, ".amp")],
        apiKeys: [],
        setupHint: "Install and authenticate the `amp` CLI.",
    },
];
const ROLE_PREFERENCES = {
    spec: ["claude", "codex"],
    research: ["gemini", "kimi", "codex", "claude"],
    plan: ["gemini", "codex", "claude", "kimi"],
    implement: ["codex", "amp", "gemini", "claude", "kimi"],
    validate: ["codex", "amp", "gemini"],
    review: ["claude", "amp", "codex"],
};
const AGENT_VARIANTS = [
    {
        derivedFrom: "claude",
        variantId: "claudeSonnet",
        displayName: "Claude Sonnet",
        constructor: {
            importName: "ClaudeCodeAgent",
            expr: 'new SmithersClaudeCodeAgent({ model: "claude-sonnet-4-7", cwd: process.cwd() })',
        },
    },
];
const SCAFFOLDED_PROVIDERS = {
    claude: "ClaudeCodeAgent",
    codex: "CodexAgent",
    gemini: "GeminiAgent",
};
const TIER_PREFERENCES = {
    cheapFast: { order: ["kimi", "claudeSonnet", "gemini", "pi"], maxSize: 2 },
    smart: { order: ["codex", "claude", "kimi", "gemini", "amp"], maxSize: 3 },
    smartTool: { order: ["claude", "codex", "kimi", "gemini", "amp"], maxSize: 3 },
};
const CONSTRUCTORS = {
    claude: {
        importName: "ClaudeCodeAgent",
        expr: 'new SmithersClaudeCodeAgent({ model: "claude-opus-4-7", cwd: process.cwd() })',
    },
    codex: {
        importName: "CodexAgent",
        expr: 'new SmithersCodexAgent({ model: "gpt-5.3-codex", cwd: process.cwd(), skipGitRepoCheck: true })',
    },
    gemini: {
        importName: "GeminiAgent",
        expr: 'new SmithersGeminiAgent({ model: "gemini-3.1-pro-preview", cwd: process.cwd() })',
    },
    pi: {
        importName: "PiAgent",
        expr: 'new SmithersPiAgent({ provider: "openai", model: "gpt-5.3-codex" })',
    },
    kimi: {
        importName: "KimiAgent",
        expr: 'new SmithersKimiAgent({ model: "kimi-latest" })',
    },
    amp: {
        importName: "AmpAgent",
        expr: "new SmithersAmpAgent()",
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
        const scaffoldedProvider = SCAFFOLDED_PROVIDERS[providerId];
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
 * @param {unknown} value
 * @returns {string[]}
 */
function extractTrustedFolderPaths(value) {
    if (Array.isArray(value)) {
        return value.filter((entry) => typeof entry === "string");
    }
    if (!value || typeof value !== "object") {
        return [];
    }
    return Object.entries(/** @type {Record<string, unknown>} */ (value))
        .filter(([, trustValue]) => trustValue === true || trustValue === "TRUST_FOLDER")
        .map(([path]) => path);
}

/**
 * @param {string} trustedPath
 * @param {string} cwd
 */
function trustedPathMatchesCwd(trustedPath, cwd) {
    const trusted = resolve(trustedPath);
    const current = resolve(cwd);
    return current === trusted || current.startsWith(trusted.endsWith(sep) ? trusted : `${trusted}${sep}`);
}

/**
 * @param {string} trustFile
 * @param {string} cwd
 * @returns {{ trusted: boolean; checks: string[] }}
 */
function readGeminiProjectTrust(trustFile, cwd) {
    let trusted = false;
    if (existsSync(trustFile)) {
        try {
            const parsed = JSON.parse(readFileSync(trustFile, "utf8"));
            trusted = extractTrustedFolderPaths(parsed).some((path) => trustedPathMatchesCwd(path, cwd));
        }
        catch {
            trusted = false;
        }
    }
    return {
        trusted,
        checks: [`project-trust:${trustFile}:${resolve(cwd)}:${trusted ? "yes" : "no"}`],
    };
}
/**
 * @param {string} binary
 * @param {NodeJS.ProcessEnv} env
 */
function commandExists(binary, env) {
    const result = spawnSync("/bin/bash", ["-c", `command -v ${binary}`], {
        env,
        encoding: "utf8",
    });
    return result.status === 0;
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
        .map((entry) => `${entry.displayName}: ${entry.usable ? "usable" : formatUnusableReasons(entry)}`)
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
        const status = computeStatus(hasBinary, hasAuthSignal, hasApiKeySignal);
        const hasCredentialSignal = hasAuthSignal || hasApiKeySignal;
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
        return {
            id: detector.id,
            displayName: detector.displayName,
            binary: detector.binary,
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
    "codex": "CodexAgent",
    "gemini": "GeminiAgent",
    "kimi": "KimiAgent",
    "anthropic-api": "ClaudeCodeAgent",
    "openai-api": "CodexAgent",
    "gemini-api": "GeminiAgent",
};

/**
 * Family the account belongs to for pool grouping (e.g. anthropic-api and
 * claude-code both go in the `claude` pool).
 * @type {Record<string, string>}
 */
const ACCOUNT_PROVIDER_POOL = {
    "claude-code": "claude",
    "anthropic-api": "claude",
    "codex": "codex",
    "openai-api": "codex",
    "gemini": "gemini",
    "gemini-api": "gemini",
    "kimi": "kimi",
};

/**
 * Default model per provider when an account doesn't specify one.
 * @type {Record<string, string>}
 */
const ACCOUNT_PROVIDER_DEFAULT_MODEL = {
    "claude-code": "claude-opus-4-7",
    "anthropic-api": "claude-opus-4-7",
    "codex": "gpt-5.4-codex",
    "openai-api": "gpt-5.4-codex",
    "gemini": "gemini-3.1-pro-preview",
    "gemini-api": "gemini-3.1-pro-preview",
    "kimi": "kimi-latest",
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
    poolLines.push(`  smart: [${allLabels.map((m) => `providers.${m}`).join(", ")}],`);
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
    if (account.apiKey) opts.push(`apiKey: ${JSON.stringify(account.apiKey)}`);
    if (account.provider === "codex" || account.provider === "openai-api") {
        opts.push("skipGitRepoCheck: true");
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
 * @param {{ cwd?: string; preserveProviderIds?: Iterable<string> }} [options]
 */
export function generateAgentsTs(env = process.env, options = {}) {
    const registeredAccounts = listAccounts(env);
    const detections = detectAvailableAgents(env, options);
    const availableById = new Map(detections.filter((entry) => entry.usable).map((entry) => [entry.id, entry]));
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
    // Base providers in detection order
    const orderedProviders = DETECTORS
        .map((detector) => availableById.get(detector.id))
        .filter((entry) => Boolean(entry));
    // Derive variants (e.g. claudeSonnet from claude)
    const availableIds = new Set(orderedProviders.map((p) => p.id));
    const activeVariants = AGENT_VARIANTS.filter((v) => availableIds.has(v.derivedFrom));
    // Smithers SDK class imports needed: detection variants + non-scaffolded
    // detection providers + every account class.
    const importNames = new Set();
    for (const provider of orderedProviders) {
        if (!(provider.id in SCAFFOLDED_PROVIDERS)) {
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
        ...orderedProviders.map((provider) => `  ${provider.id}: ${SCAFFOLDED_PROVIDERS[provider.id] ?? CONSTRUCTORS[provider.id].expr},`),
        ...activeVariants.map((variant) => `  ${variant.variantId}: ${variant.constructor.expr},`),
        ...registeredAccounts.map((account) => renderAccountProviderLine(account, homeDir)),
    ];
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
    const tierLines = Object.entries(TIER_PREFERENCES).flatMap(([tier, { order, maxSize }]) => {
        let resolved = order
            .filter((id) => allProviderIds.has(id))
            .slice(0, maxSize);
        if (resolved.length === 0) {
            resolved = fallbackIds.slice(0, maxSize);
        }
        const tierFamilies = new Set(order);
        const tierAccounts = registeredAccounts
            .filter((account) => tierFamilies.has(ACCOUNT_PROVIDER_POOL[account.provider]))
            .map((account) => labelToCamel(account.label));
        const merged = [...resolved, ...tierAccounts];
        return renderTierLine(
            tier,
            merged,
            renderUnavailablePreferenceComments(tier, order, allProviderIds, detectionsById),
        );
    });
    return [
        "// smithers-source: generated",
        ...(hasAccounts ? ["// Account providers (camelCase labels) come from ~/.smithers/accounts.json — managed via `smithers agent add|list|remove`."] : []),
        ...(hasAccounts ? ['import { homedir } from "node:os";', 'import path from "node:path";'] : []),
        `import { ${smithersImportSpecifiers.join(", ")} } from "smithers-orchestrator";`,
        'import { ClaudeCodeAgent } from "./agents/claude-code";',
        'import { CodexAgent } from "./agents/codex";',
        'import { GeminiAgent } from "./agents/gemini";',
        "",
        'export { ClaudeCodeAgent } from "./agents/claude-code";',
        'export { CodexAgent } from "./agents/codex";',
        'export { GeminiAgent } from "./agents/gemini";',
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

/**
 * The agents registry surface: a discovery + registration view over the coding
 * agents Smithers can drive. Ported from the Swift AgentsView (provider cards +
 * status icons) and extended into a registry that matches the `smithers agents`
 * CLI: multiple labeled accounts per provider, each registered with either a
 * subscription config dir (`--config-dir`) or an api key (`--api-key`).
 *
 * The original `AGENTS` table + `Agent` type stay exported so the compact
 * AgentsCard keeps rendering; the canvas leans on the richer Account model and
 * the pure status/validation helpers below, all unit-tested without a DOM (see
 * agentsDomain.test.ts). Seeded like the other feature cards — no gateway, no
 * spawn, no wall-clock.
 */

/** A coding agent / provider available to Smithers (legacy card shape). */
export type Agent = {
  id: string;
  name: string;
  initials: string;
  color: string;
  detail: string;
  auth?: string;
  available: boolean;
};

export const AGENTS: Agent[] = [
  {
    id: "claude",
    name: "Claude Code",
    initials: "C",
    color: "#0f8f78",
    detail: "claude-opus-4-8 · code, review",
    auth: "oauth",
    available: true,
  },
  {
    id: "codex",
    name: "Codex",
    initials: "X",
    color: "#356fd2",
    detail: "gpt-5.5 · code",
    auth: "key set",
    available: true,
  },
  {
    id: "cerebras",
    name: "Cerebras",
    initials: "Cb",
    color: "#bf5b16",
    detail: "zai-glm-4.7 · chat",
    auth: "key set",
    available: true,
  },
  {
    id: "gemini",
    name: "Gemini",
    initials: "G",
    color: "#9a9aa3",
    detail: "not detected",
    available: false,
  },
];

// ---------------------------------------------------------------------------
// Registry model
// ---------------------------------------------------------------------------

/** How a provider authenticates: a logged-in CLI vs a raw api key. */
export type AuthMode = "subscription" | "api-key";

/** A registry agent role (drives the default roles a new account inherits). */
export type AgentRole = "coding" | "review" | "spec" | "research" | "implement" | "chat";

/**
 * A provider in the fixed catalog the `smithers agents add` CLI exposes. Carries
 * the display metadata the rows and the registration drawer render from, so a
 * provider looks the same everywhere it appears.
 */
export type Provider = {
  id: string;
  name: string;
  /** Avatar initials, e.g. "C" / "Ag". */
  initials: string;
  /** Brand color for the avatar chip. */
  color: string;
  authMode: AuthMode;
  defaultRoles: AgentRole[];
  /** Placeholder shown in the drawer's Model field. */
  modelPlaceholder: string;
};

/**
 * The status taxonomy ported verbatim from the backend's agent detection: an
 * account is unavailable when it cannot be used; otherwise a logged-in CLI reads
 * as a likely subscription, a raw key reads as api-key, and a bare binary with
 * neither reads as binary-only.
 */
export type AgentStatus = "likely-subscription" | "api-key" | "binary-only" | "unavailable";

/**
 * One registered or auto-detected account. `registered` distinguishes a user's
 * labeled account (removable) from a provider the detection pass merely found.
 * `usable`/`hasAuth`/`hasAPIKey` are the raw detection signals `deriveStatus`
 * folds into a single status.
 */
export type Account = {
  /** Unique label, the registry key (`--label`). */
  label: string;
  providerId: string;
  /** Display name (provider name, or a per-account override). */
  name: string;
  model: string;
  roles: AgentRole[];
  /** The launch command, e.g. "claude". */
  command: string;
  /** Resolved binary path, "" when not on PATH. */
  binary: string;
  /** Per-account CLI config dir (`--config-dir`), "" for api-key accounts. */
  configDir: string;
  usable: boolean;
  hasAuth: boolean;
  hasAPIKey: boolean;
  /** A user-registered account (removable) vs an auto-detected one. */
  registered: boolean;
};

/** The 8 providers the `smithers agents add` CLI exposes, in catalog order. */
export const PROVIDERS: Provider[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    initials: "C",
    color: "#0f8f78",
    authMode: "subscription",
    defaultRoles: ["coding", "review", "spec"],
    modelPlaceholder: "claude-opus-4-8",
  },
  {
    id: "antigravity",
    name: "Antigravity",
    initials: "Ag",
    color: "#6d56d8",
    authMode: "subscription",
    defaultRoles: ["coding", "research"],
    modelPlaceholder: "gemini-3-pro",
  },
  {
    id: "codex",
    name: "Codex",
    initials: "X",
    color: "#356fd2",
    authMode: "subscription",
    defaultRoles: ["coding", "implement"],
    modelPlaceholder: "gpt-5.5",
  },
  {
    id: "gemini",
    name: "Gemini",
    initials: "G",
    color: "#9a9aa3",
    authMode: "subscription",
    defaultRoles: ["coding", "research"],
    modelPlaceholder: "gemini-3-pro",
  },
  {
    id: "kimi",
    name: "Kimi",
    initials: "K",
    color: "#bf5b16",
    authMode: "subscription",
    defaultRoles: ["coding", "chat"],
    modelPlaceholder: "kimi-k2",
  },
  {
    id: "anthropic-api",
    name: "Anthropic API",
    initials: "An",
    color: "#0f8f78",
    authMode: "api-key",
    defaultRoles: ["coding", "review"],
    modelPlaceholder: "claude-opus-4-8",
  },
  {
    id: "openai-api",
    name: "OpenAI API",
    initials: "Oa",
    color: "#10a37f",
    authMode: "api-key",
    defaultRoles: ["coding", "implement"],
    modelPlaceholder: "gpt-5.5",
  },
  {
    id: "gemini-api",
    name: "Gemini API",
    initials: "Ga",
    color: "#356fd2",
    authMode: "api-key",
    defaultRoles: ["coding", "research"],
    modelPlaceholder: "gemini-3-pro",
  },
];

/** Look the provider up by id (the drawer + rows need its display metadata). */
export function findProvider(id: string): Provider | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

/**
 * One account row as it arrives from the gateway `listAccounts` RPC — the live
 * registry source (`~/.smithers/accounts.json`, what `smithers agents` manages).
 * The raw API key is NEVER on the wire: `hasApiKey`/`hasConfigDir` carry the
 * auth posture instead. Shape mirrors the gateway's `GatewayAccount`.
 */
export type GatewayAccountRow = {
  label: string;
  providerId: string;
  configDir: string | null;
  hasConfigDir: boolean;
  hasApiKey: boolean;
  model: string | null;
};

/** The launch command for a provider id — the api-key providers drop the `-api` suffix. */
function commandForProvider(providerId: string): string {
  return providerId.replace(/-api$/, "");
}

/**
 * Map one live `listAccounts` RPC row onto the surface's `Account`. Every
 * registered account is `registered: true` (it lives in the user's registry).
 * Its detection signals come straight from the gateway's redacted posture: a
 * subscription provider with a config dir reads as `hasAuth`; an api-key
 * provider with a key set reads as `hasAPIKey`; an account is `usable` when it
 * carries either. Display fields (name, roles, command) fall back to the static
 * PROVIDERS catalog so an unknown provider id still renders a sane row; `binary`
 * is unknown over the wire (the gateway does not resolve PATH), so it is "".
 */
export function accountFromGateway(row: GatewayAccountRow): Account {
  const provider = findProvider(row.providerId);
  const hasAuth = provider?.authMode !== "api-key" && row.hasConfigDir;
  const hasAPIKey = provider?.authMode === "api-key" && row.hasApiKey;
  return {
    label: row.label,
    providerId: row.providerId,
    name: provider ? provider.name : row.providerId,
    model: row.model ?? provider?.modelPlaceholder ?? "",
    roles: provider ? provider.defaultRoles.slice() : [],
    command: commandForProvider(row.providerId),
    binary: "",
    configDir: row.configDir ?? "",
    usable: hasAuth || hasAPIKey,
    hasAuth,
    hasAPIKey,
    registered: true,
  };
}

/**
 * Fold the raw detection signals into one status, ported verbatim from the
 * backend: unusable wins (→ unavailable); otherwise a logged-in CLI is a likely
 * subscription, then a raw key is api-key, then a bare binary is binary-only.
 */
export function deriveStatus(account: {
  usable: boolean;
  hasAuth: boolean;
  hasAPIKey: boolean;
}): AgentStatus {
  if (!account.usable) return "unavailable";
  if (account.hasAuth) return "likely-subscription";
  if (account.hasAPIKey) return "api-key";
  return "binary-only";
}

/** Whether the account can be launched (status is anything but unavailable). */
export function isUsable(account: Account): boolean {
  return account.usable;
}

/** The human label for a status, shown in the detail header state-badge. */
export const STATUS_LABEL: Record<AgentStatus, string> = {
  "likely-subscription": "Subscription",
  "api-key": "API key",
  "binary-only": "Binary only",
  unavailable: "Not detected",
};

/** The tone class a status maps to, for the badge + glyph color. */
export const STATUS_TONE: Record<AgentStatus, string> = {
  "likely-subscription": "tone-ok",
  "api-key": "tone-waiting",
  "binary-only": "tone-idle",
  unavailable: "tone-idle",
};

/** The status-glyph modifier class, for the colored ●/◐/○ in the list rows. */
export const STATUS_GLYPH_CLASS: Record<AgentStatus, string> = {
  "likely-subscription": "is-subscription",
  "api-key": "is-apikey",
  "binary-only": "is-binary",
  unavailable: "is-unavailable",
};

/** The glyph character a status renders, ported from Swift statusIcon. */
export const STATUS_GLYPH: Record<AgentStatus, string> = {
  "likely-subscription": "●",
  "api-key": "●",
  "binary-only": "◐",
  unavailable: "○",
};

/** A short availability tag (Swift statusTag), e.g. "subscription" / "api key". */
export const STATUS_TAG: Record<AgentStatus, string> = {
  "likely-subscription": "subscription",
  "api-key": "api key",
  "binary-only": "binary",
  unavailable: "not detected",
};

/** Capitalize one role for display (Swift capitalizeRole), e.g. coding→Coding. */
export function capitalizeRole(role: string): string {
  if (role.length === 0) return role;
  return role[0].toUpperCase() + role.slice(1);
}

/** Comma-joined, capitalized role list; "-" when empty (Swift formattedRoles). */
export function formattedRoles(roles: string[]): string {
  if (roles.length === 0) return "-";
  return roles.map(capitalizeRole).join(", ");
}

/** Render a boolean as Yes/No, ported from Swift yesNo(). */
export function yesNo(value: boolean): string {
  return value ? "Yes" : "No";
}

/** The filter over the list rail: all accounts, usable only, or unavailable only. */
export type AgentFilter = "all" | "available" | "unavailable";

/** Keep only the accounts the filter admits. */
export function filterAccounts(accounts: Account[], filter: AgentFilter): Account[] {
  if (filter === "all") return accounts.slice();
  if (filter === "available") return accounts.filter((account) => account.usable);
  return accounts.filter((account) => !account.usable);
}

/**
 * Order the list the Swift view does: usable accounts first (available group),
 * then unavailable. Stable within each group, so the seed order shows through.
 */
export function orderAccounts(accounts: Account[]): Account[] {
  const available = accounts.filter((account) => account.usable);
  const unavailable = accounts.filter((account) => !account.usable);
  return [...available, ...unavailable];
}

/** Headline counts for the surface-sub and the card sub. */
export function summarizeAccounts(accounts: Account[]): {
  total: number;
  available: number;
  unavailable: number;
} {
  let available = 0;
  for (const account of accounts) {
    if (account.usable) available += 1;
  }
  return {
    total: accounts.length,
    available,
    unavailable: accounts.length - available,
  };
}

/** The registration draft the drawer collects, before it becomes an Account. */
export type AccountDraft = {
  providerId: string | null;
  label: string;
  configDir: string;
  apiKey: string;
  model: string;
  /** The `--force`/skip-login affordance: register even without auth. */
  force: boolean;
};

/**
 * Validate a registration draft, returning the first blocking error message or
 * null when the draft is submittable. Pure, so the submit-gate and the inline
 * error both read the same rule (mirrors `smithers agents add` validation):
 *   - a provider must be picked,
 *   - the label is required and unique (trimmed, case-sensitive),
 *   - api-key providers need a non-empty key unless `force`,
 *   - subscription providers need a config dir unless `force`.
 */
export function validateDraft(draft: AccountDraft, existing: Account[]): string | null {
  const provider = draft.providerId ? findProvider(draft.providerId) : undefined;
  if (!provider) return "Pick a provider.";
  const label = draft.label.trim();
  if (label === "") return "Label is required.";
  if (existing.some((account) => account.label === label)) {
    return `A label "${label}" already exists.`;
  }
  if (provider.authMode === "api-key" && draft.apiKey.trim() === "" && !draft.force) {
    return "An API key is required (or enable Force).";
  }
  if (provider.authMode === "subscription" && draft.configDir.trim() === "" && !draft.force) {
    return "A config dir is required (or enable Force).";
  }
  return null;
}

/**
 * Build the new Account from a (validated) draft, deriving its detection signals
 * from the chosen auth mode: an entered api key → usable api-key account; a
 * config dir → usable subscription account; neither + force → an unavailable
 * binary-only stub. Pure: the store calls `validateDraft` first, then this.
 */
export function registerAccount(draft: AccountDraft, existing: Account[]): Account | null {
  if (validateDraft(draft, existing) !== null) return null;
  const provider = findProvider(draft.providerId!)!;
  const label = draft.label.trim();
  const configDir = draft.configDir.trim();
  const apiKey = draft.apiKey.trim();
  const model = draft.model.trim() || provider.modelPlaceholder;

  const hasAPIKey = provider.authMode === "api-key" && apiKey !== "";
  const hasAuth = provider.authMode === "subscription" && configDir !== "";
  const usable = hasAuth || hasAPIKey;

  return {
    label,
    providerId: provider.id,
    name: provider.name,
    model,
    roles: provider.defaultRoles.slice(),
    command: provider.id.replace(/-api$/, ""),
    binary: "",
    configDir: provider.authMode === "subscription" ? configDir : "",
    usable,
    hasAuth,
    hasAPIKey,
    registered: true,
  };
}

/** Prepend a freshly registered account, returning a new list. */
export function addAccount(accounts: Account[], account: Account): Account[] {
  return [account, ...accounts];
}

/**
 * Drop a registered account by label. Auto-detected accounts (registered=false)
 * are guarded — discovering a provider does not make it removable.
 */
export function removeAccount(accounts: Account[], label: string): Account[] {
  return accounts.filter(
    (account) => !(account.label === label && account.registered),
  );
}

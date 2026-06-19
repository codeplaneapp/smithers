import { describe, expect, test } from "bun:test";
import {
  addAccount,
  capitalizeRole,
  deriveStatus,
  filterAccounts,
  findProvider,
  formattedRoles,
  orderAccounts,
  PROVIDERS,
  registerAccount,
  removeAccount,
  SEEDED_ACCOUNTS,
  summarizeAccounts,
  validateDraft,
  yesNo,
  type AccountDraft,
} from "./agents";

/**
 * Pure domain tests for the agents registry: the status taxonomy, the
 * filter/order helpers, and the draft validation + registration reducers the
 * card and canvas lean on. No DOM, no store.
 */

const baseDraft: AccountDraft = {
  providerId: null,
  label: "",
  configDir: "",
  apiKey: "",
  model: "",
  force: false,
};

describe("PROVIDERS catalog", () => {
  test("exposes the supported providers with stable ids", () => {
    expect(PROVIDERS).toHaveLength(7);
    expect(PROVIDERS.map((p) => p.id)).toEqual([
      "claude-code",
      "antigravity",
      "codex",
      "kimi",
      "anthropic-api",
      "openai-api",
      "gemini-api",
    ]);
  });

  test("splits into 4 subscription + 3 api-key providers", () => {
    expect(PROVIDERS.filter((p) => p.authMode === "subscription")).toHaveLength(4);
    expect(PROVIDERS.filter((p) => p.authMode === "api-key")).toHaveLength(3);
  });

  test("findProvider resolves by id and misses cleanly", () => {
    expect(findProvider("codex")?.name).toBe("Codex");
    expect(findProvider("nope")).toBeUndefined();
  });
});

describe("deriveStatus", () => {
  test("unusable wins over every auth signal", () => {
    expect(deriveStatus({ usable: false, hasAuth: true, hasAPIKey: true })).toBe("unavailable");
  });

  test("logged-in CLI reads as a likely subscription", () => {
    expect(deriveStatus({ usable: true, hasAuth: true, hasAPIKey: false })).toBe("likely-subscription");
  });

  test("a raw key reads as api-key", () => {
    expect(deriveStatus({ usable: true, hasAuth: false, hasAPIKey: true })).toBe("api-key");
  });

  test("a bare usable binary reads as binary-only", () => {
    expect(deriveStatus({ usable: true, hasAuth: false, hasAPIKey: false })).toBe("binary-only");
  });
});

describe("filterAccounts", () => {
  test("available keeps only usable accounts", () => {
    const available = filterAccounts(SEEDED_ACCOUNTS, "available");
    expect(available.length).toBeGreaterThan(0);
    expect(available.every((a) => a.usable)).toBe(true);
  });

  test("unavailable keeps only non-usable accounts", () => {
    const unavailable = filterAccounts(SEEDED_ACCOUNTS, "unavailable");
    expect(unavailable.length).toBeGreaterThan(0);
    expect(unavailable.every((a) => !a.usable)).toBe(true);
  });

  test("all keeps every account and is a fresh array", () => {
    const all = filterAccounts(SEEDED_ACCOUNTS, "all");
    expect(all).toEqual(SEEDED_ACCOUNTS);
    expect(all).not.toBe(SEEDED_ACCOUNTS);
  });
});

describe("orderAccounts", () => {
  test("usable accounts come first, then unavailable, stable within each group", () => {
    const ordered = orderAccounts(SEEDED_ACCOUNTS);
    const firstUnavailable = ordered.findIndex((a) => !a.usable);
    expect(firstUnavailable).toBeGreaterThan(0);
    expect(ordered.slice(0, firstUnavailable).every((a) => a.usable)).toBe(true);
    expect(ordered.slice(firstUnavailable).every((a) => !a.usable)).toBe(true);
    // Stable: same labels overall, just regrouped.
    expect(ordered.map((a) => a.label).sort()).toEqual(SEEDED_ACCOUNTS.map((a) => a.label).sort());
  });
});

describe("summarizeAccounts", () => {
  test("available + unavailable equals total", () => {
    const s = summarizeAccounts(SEEDED_ACCOUNTS);
    expect(s.total).toBe(SEEDED_ACCOUNTS.length);
    expect(s.available + s.unavailable).toBe(s.total);
    expect(s.available).toBeGreaterThan(0);
    expect(s.unavailable).toBeGreaterThan(0);
  });
});

describe("role + yesNo formatting", () => {
  test("capitalizeRole title-cases one role", () => {
    expect(capitalizeRole("coding")).toBe("Coding");
    expect(capitalizeRole("")).toBe("");
  });

  test("formattedRoles joins capitalized roles, '-' when empty", () => {
    expect(formattedRoles(["coding", "review", "spec"])).toBe("Coding, Review, Spec");
    expect(formattedRoles([])).toBe("-");
  });

  test("yesNo maps booleans to Yes/No", () => {
    expect(yesNo(true)).toBe("Yes");
    expect(yesNo(false)).toBe("No");
  });
});

describe("validateDraft", () => {
  test("requires a provider", () => {
    expect(validateDraft(baseDraft, SEEDED_ACCOUNTS)).toBe("Pick a provider.");
  });

  test("requires a non-empty, trimmed label", () => {
    const draft = { ...baseDraft, providerId: "claude-code", configDir: "~/.x", label: "   " };
    expect(validateDraft(draft, SEEDED_ACCOUNTS)).toBe("Label is required.");
  });

  test("rejects a duplicate label among existing accounts", () => {
    const draft = { ...baseDraft, providerId: "claude-code", configDir: "~/.x", label: "claude-work" };
    expect(validateDraft(draft, SEEDED_ACCOUNTS)).toContain("already exists");
  });

  test("api-key providers need a key unless force", () => {
    const draft = { ...baseDraft, providerId: "anthropic-api", label: "fresh-key" };
    expect(validateDraft(draft, SEEDED_ACCOUNTS)).toContain("API key is required");
    expect(validateDraft({ ...draft, apiKey: "sk-123" }, SEEDED_ACCOUNTS)).toBeNull();
    expect(validateDraft({ ...draft, force: true }, SEEDED_ACCOUNTS)).toBeNull();
  });

  test("subscription providers need a config dir unless force", () => {
    const draft = { ...baseDraft, providerId: "claude-code", label: "fresh-sub" };
    expect(validateDraft(draft, SEEDED_ACCOUNTS)).toContain("config dir is required");
    expect(validateDraft({ ...draft, configDir: "~/.claude" }, SEEDED_ACCOUNTS)).toBeNull();
    expect(validateDraft({ ...draft, force: true }, SEEDED_ACCOUNTS)).toBeNull();
  });
});

describe("registerAccount", () => {
  test("returns null for an invalid draft", () => {
    expect(registerAccount(baseDraft, SEEDED_ACCOUNTS)).toBeNull();
  });

  test("a config dir yields a usable likely-subscription account", () => {
    const draft = {
      ...baseDraft,
      providerId: "claude-code",
      label: "claude-ci",
      configDir: "~/.claude-ci",
    };
    const created = registerAccount(draft, SEEDED_ACCOUNTS)!;
    expect(created).not.toBeNull();
    expect(created.label).toBe("claude-ci");
    expect(created.usable).toBe(true);
    expect(created.hasAuth).toBe(true);
    expect(created.hasAPIKey).toBe(false);
    expect(created.registered).toBe(true);
    expect(deriveStatus(created)).toBe("likely-subscription");
    expect(created.configDir).toBe("~/.claude-ci");
    // Empty model falls back to the provider placeholder.
    expect(created.model).toBe("claude-opus-4-8");
  });

  test("an api key yields a usable api-key account and trims the label", () => {
    const draft = {
      ...baseDraft,
      providerId: "openai-api",
      label: "  openai-prod  ",
      apiKey: "sk-prod",
      model: "gpt-5.5",
    };
    const created = registerAccount(draft, SEEDED_ACCOUNTS)!;
    expect(created.label).toBe("openai-prod");
    expect(created.usable).toBe(true);
    expect(created.hasAPIKey).toBe(true);
    expect(created.hasAuth).toBe(false);
    expect(deriveStatus(created)).toBe("api-key");
    // api-key accounts carry no config dir.
    expect(created.configDir).toBe("");
    expect(created.model).toBe("gpt-5.5");
  });

  test("force with neither auth field yields an unavailable binary-only stub", () => {
    const draft = { ...baseDraft, providerId: "kimi", label: "kimi-stub", force: true };
    const created = registerAccount(draft, SEEDED_ACCOUNTS)!;
    expect(created.usable).toBe(false);
    expect(created.hasAuth).toBe(false);
    expect(created.hasAPIKey).toBe(false);
    expect(deriveStatus(created)).toBe("unavailable");
  });
});

describe("addAccount / removeAccount", () => {
  test("addAccount prepends without mutating the input", () => {
    const created = registerAccount(
      { ...baseDraft, providerId: "claude-code", label: "x", configDir: "~/.x" },
      SEEDED_ACCOUNTS,
    )!;
    const next = addAccount(SEEDED_ACCOUNTS, created);
    expect(next[0]).toBe(created);
    expect(next.length).toBe(SEEDED_ACCOUNTS.length + 1);
    expect(SEEDED_ACCOUNTS.length).not.toBe(next.length);
  });

  test("removeAccount drops a registered account by label", () => {
    const target = SEEDED_ACCOUNTS.find((a) => a.registered)!;
    const next = removeAccount(SEEDED_ACCOUNTS, target.label);
    expect(next.some((a) => a.label === target.label)).toBe(false);
    expect(next.length).toBe(SEEDED_ACCOUNTS.length - 1);
  });

  test("removeAccount guards auto-detected (non-registered) accounts", () => {
    const detected = SEEDED_ACCOUNTS.find((a) => !a.registered)!;
    const next = removeAccount(SEEDED_ACCOUNTS, detected.label);
    expect(next.some((a) => a.label === detected.label)).toBe(true);
    expect(next.length).toBe(SEEDED_ACCOUNTS.length);
  });
});

describe("SEEDED_ACCOUNTS invariants", () => {
  test("labels are unique and every providerId is in the catalog", () => {
    const labels = SEEDED_ACCOUNTS.map((a) => a.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const account of SEEDED_ACCOUNTS) {
      expect(findProvider(account.providerId)).toBeDefined();
    }
  });

  test("usable accounts carry at least one auth signal", () => {
    for (const account of SEEDED_ACCOUNTS) {
      if (account.usable) {
        expect(account.hasAuth || account.hasAPIKey).toBe(true);
      }
    }
  });
});

import { create } from "zustand";
import { useChatStore } from "../chat/chatStore";
import { useNotificationsStore } from "../notifications/notificationsStore";
import { getGatewayClient } from "../gateway/gatewayClient";
import {
  accountFromGateway,
  addAccount,
  findProvider,
  registerAccount,
  removeAccount,
  validateDraft,
  type Account,
  type AccountDraft,
  type AgentFilter,
  type GatewayAccountRow,
} from "./agents";

/**
 * The agents-registry store: the LIVE account list hydrated from the gateway
 * `listAccounts` RPC plus the selection, filter, and registration-drawer draft
 * the card and canvas read. The accounts are the real entries in the user's
 * `~/.smithers/accounts.json` registry (what `smithers agents` manages); the
 * store starts EMPTY and `load()` replaces it from the RPC on mount + on every
 * `refresh()`/local-mode poll.
 *
 * Register/remove/test stay CLIENT-SIDE echoes (there is no accounts-write RPC
 * yet — that persistence backend is deferred): they mutate the local list and
 * emit a chat line + a transient toast the way the vcs/issues stores do. Zero
 * useState anywhere; the canvas reads slices via selectors and derives the rest
 * in its render body.
 */
type AgentsState = {
  accounts: Account[];
  /**
   * Locally-registered accounts the gateway has NOT yet reported. Register is a
   * client-side echo (there is no accounts-write RPC), so a just-registered
   * account would vanish on the next `hydrate()` if it were not preserved here.
   * An entry is dropped once the gateway reports its label (the write landed) or
   * it is removed.
   */
  localAccounts: Account[];
  /**
   * Labels removed locally (a client-side echo). A live gateway row for one of
   * these stays suppressed across `hydrate()` so a removed account does not
   * reappear on the next poll. The label is un-suppressed when it is registered
   * again.
   */
  removedLabels: string[];
  selectedLabel: string | null;
  filter: AgentFilter;
  /** The registration drawer is open. */
  registering: boolean;
  draftProviderId: string | null;
  draftLabel: string;
  draftConfigDir: string;
  draftApiKey: string;
  draftModel: string;
  draftForce: boolean;

  select: (label: string) => void;
  setFilter: (filter: AgentFilter) => void;
  openRegister: () => void;
  cancelRegister: () => void;
  pickProvider: (providerId: string) => void;
  setDraftLabel: (value: string) => void;
  setDraftConfigDir: (value: string) => void;
  setDraftApiKey: (value: string) => void;
  setDraftModel: (value: string) => void;
  toggleDraftForce: () => void;
  submitRegister: () => void;
  remove: (label: string) => void;
  test: (label: string) => void;
  /** Replace the live account list from gateway RPC rows (the bridge/hydration seam). */
  hydrate: (rows: GatewayAccountRow[]) => void;
  /** Pull the live `listAccounts` RPC and hydrate; returns the in-flight promise. */
  load: () => Promise<void>;
  refresh: () => void;
};

/** Clear every draft field back to its empty default (drawer close / submit). */
const EMPTY_DRAFT = {
  draftProviderId: null as string | null,
  draftLabel: "",
  draftConfigDir: "",
  draftApiKey: "",
  draftModel: "",
  draftForce: false,
};

/**
 * Call the live `listAccounts` RPC through the shared gateway client. The
 * response is the gateway's redacted `GatewayAccount[]` (no raw api keys); it is
 * shaped to the surface's `GatewayAccountRow` (only the fields the mapper reads).
 * Overridable for unit tests via `setListAccountsRpcForTests`.
 */
type ListAccountsRpc = () => Promise<GatewayAccountRow[]>;

const defaultListAccountsRpc: ListAccountsRpc = async () => {
  const payload = (await getGatewayClient().rpcRaw("listAccounts", {})) as Array<{
    label: string;
    provider: string;
    configDir?: string | null;
    hasConfigDir?: boolean;
    hasApiKey?: boolean;
    model?: string | null;
  }>;
  return (Array.isArray(payload) ? payload : []).map((row) => ({
    label: row.label,
    providerId: row.provider,
    configDir: row.configDir ?? null,
    hasConfigDir: row.hasConfigDir === true,
    hasApiKey: row.hasApiKey === true,
    model: row.model ?? null,
  }));
};

let listAccountsRpc: ListAccountsRpc = defaultListAccountsRpc;

/** Override the live RPC seam (tests). Pass `undefined` to restore the default. */
export function setListAccountsRpcForTests(rpc: ListAccountsRpc | undefined): void {
  listAccountsRpc = rpc ?? defaultListAccountsRpc;
}

/**
 * Reconcile the live gateway account rows with the client-side echoes that have
 * no write-RPC backing yet. The gateway is the source of truth for the accounts
 * it KNOWS; on top of that we:
 *
 *   - SUPPRESS any gateway row whose label was removed locally (`removedLabels`),
 *     so a removed account does not reappear on the next poll until a real
 *     write-RPC reconciliation drops it from the gateway too;
 *   - PRESERVE locally-registered accounts the gateway has not reported yet
 *     (`localAccounts`), so a just-registered account survives a `hydrate()`.
 *     Once the gateway reports a label, its live row wins and the matching local
 *     echo is dropped (it landed).
 *
 * Pure: returns the merged list + the local echoes that are still pending (the
 * gateway has not yet reported them), so the store can prune confirmed ones.
 */
export function mergeAccounts(
  gatewayRows: GatewayAccountRow[],
  localAccounts: Account[],
  removedLabels: string[],
): { accounts: Account[]; remainingLocal: Account[] } {
  const removed = new Set(removedLabels);
  const liveLabels = new Set(gatewayRows.map((row) => row.label));
  // Gateway rows are the truth for what it knows, minus locally-removed labels.
  const liveAccounts = gatewayRows
    .filter((row) => !removed.has(row.label))
    .map(accountFromGateway);
  // Keep only local echoes the gateway has not yet confirmed (and that have not
  // since been removed locally). A confirmed one is pruned — the live row wins.
  const remainingLocal = localAccounts.filter(
    (account) => !liveLabels.has(account.label) && !removed.has(account.label),
  );
  return { accounts: [...remainingLocal, ...liveAccounts], remainingLocal };
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  // Hydrated live by the canvas's mount effect from the `listAccounts` gateway
  // RPC. Starts empty; `hydrate()` MERGES live rows with the client-side echoes
  // below on the first pull and every poll/refresh.
  accounts: [],
  localAccounts: [],
  removedLabels: [],
  selectedLabel: null,
  filter: "available",
  registering: false,
  ...EMPTY_DRAFT,

  select: (label) => set({ selectedLabel: label }),

  setFilter: (filter) => set({ filter }),

  openRegister: () =>
    set({
      registering: true,
      // Preselect the first subscription provider so the drawer renders a field.
      draftProviderId: "claude-code",
      draftLabel: "",
      draftConfigDir: "",
      draftApiKey: "",
      draftModel: "",
      draftForce: false,
    }),

  cancelRegister: () => set({ registering: false, ...EMPTY_DRAFT }),

  pickProvider: (providerId) => {
    const provider = findProvider(providerId);
    // Reset the auth field that no longer applies, so a stale value never leaks
    // from a subscription provider into an api-key one (or vice versa).
    set({
      draftProviderId: providerId,
      draftConfigDir: provider?.authMode === "subscription" ? get().draftConfigDir : "",
      draftApiKey: provider?.authMode === "api-key" ? get().draftApiKey : "",
    });
  },

  setDraftLabel: (value) => set({ draftLabel: value }),
  setDraftConfigDir: (value) => set({ draftConfigDir: value }),
  setDraftApiKey: (value) => set({ draftApiKey: value }),
  setDraftModel: (value) => set({ draftModel: value }),
  toggleDraftForce: () => set((state) => ({ draftForce: !state.draftForce })),

  submitRegister: () => {
    const { accounts, draftProviderId, draftLabel, draftConfigDir, draftApiKey, draftModel, draftForce } =
      get();
    const draft: AccountDraft = {
      providerId: draftProviderId,
      label: draftLabel,
      configDir: draftConfigDir,
      apiKey: draftApiKey,
      model: draftModel,
      force: draftForce,
    };
    // The submit button is gated on validateDraft already; re-check so the
    // action is a safe no-op if called while invalid.
    if (validateDraft(draft, accounts) !== null) return;
    const created = registerAccount(draft, accounts);
    if (!created) return;
    const { localAccounts, removedLabels } = get();
    set({
      accounts: addAccount(accounts, created),
      // Echo the registration into the local-pending set so the next `hydrate()`
      // (mount / poll / refresh) preserves it until the gateway confirms it, and
      // un-suppress the label in case it was previously removed locally.
      localAccounts: [created, ...localAccounts.filter((a) => a.label !== created.label)],
      removedLabels: removedLabels.filter((label) => label !== created.label),
      selectedLabel: created.label,
      registering: false,
      ...EMPTY_DRAFT,
    });
    useChatStore.getState().say(`Registered agent: ${created.label} (${created.model}).`);
    useNotificationsStore.getState().notify({
      title: "Agent registered",
      detail: `${created.label} · ${created.name}`,
      kind: "transient",
      command: "chat",
    });
  },

  remove: (label) => {
    const { accounts, selectedLabel, localAccounts, removedLabels } = get();
    const target = accounts.find((account) => account.label === label && account.registered);
    if (!target) return;
    set({
      accounts: removeAccount(accounts, label),
      // Drop any local-pending echo for this label, and remember the removal so a
      // live gateway row for it stays suppressed across the next poll (the remove
      // is a client-side echo — there is no write-RPC to drop it server-side yet).
      localAccounts: localAccounts.filter((account) => account.label !== label),
      removedLabels: removedLabels.includes(label) ? removedLabels : [...removedLabels, label],
      selectedLabel: selectedLabel === label ? null : selectedLabel,
    });
    useChatStore.getState().say(`Removed agent: ${label}.`);
    useNotificationsStore.getState().notify({
      title: "Agent removed",
      detail: label,
      kind: "transient",
      command: "chat",
    });
  },

  test: (label) => {
    const { accounts } = get();
    const target = accounts.find((account) => account.label === label);
    if (!target) return;
    // Deterministic acknowledgement — no real spawn (mirrors `agents test`).
    useChatStore
      .getState()
      .say(`Spawned \`${target.command} --version\` for **${label}** — reachable.`);
  },

  hydrate: (rows) => {
    set((state) => {
      // MERGE — do not blindly replace. The gateway is the truth for the accounts
      // it knows, but client-side echoes (locally-registered accounts not yet on
      // the gateway, locally-removed labels) are preserved until the gateway
      // itself reconciles them. Prune any local echoes the gateway now confirms.
      const { accounts, remainingLocal } = mergeAccounts(rows, state.localAccounts, state.removedLabels);
      // Drop suppressed labels the gateway no longer reports — the removal has
      // landed, so there is nothing left to suppress.
      const liveLabels = new Set(rows.map((row) => row.label));
      const removedLabels = state.removedLabels.filter((label) => liveLabels.has(label));
      return {
        accounts,
        localAccounts: remainingLocal,
        removedLabels,
        // Reconcile the open selection against the new merged set so a removed
        // account can never strand the detail pane on a vanished row.
        selectedLabel:
          state.selectedLabel && accounts.some((account) => account.label === state.selectedLabel)
            ? state.selectedLabel
            : null,
      };
    });
  },

  load: async () => {
    const rows = await listAccountsRpc();
    get().hydrate(rows);
  },

  refresh: () => {
    void get()
      .load()
      .then(() => {
        const { accounts } = get();
        const available = accounts.filter((account) => account.usable).length;
        useChatStore
          .getState()
          .say(
            `Re-ran agent detection — ${available} available, ${accounts.length - available} not detected.`,
          );
      })
      .catch(() => {
        useChatStore.getState().say("Agent detection failed — gateway unreachable.");
      });
  },
}));

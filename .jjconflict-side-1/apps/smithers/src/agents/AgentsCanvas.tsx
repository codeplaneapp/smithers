import "./agents.css";
import { useCallback, useEffect } from "react";
import { useLocalModeRefetch } from "../sync/useLocalModeRefetch";
import {
  deriveStatus,
  findProvider,
  formattedRoles,
  orderAccounts,
  PROVIDERS,
  STATUS_GLYPH,
  STATUS_GLYPH_CLASS,
  STATUS_LABEL,
  STATUS_TAG,
  STATUS_TONE,
  summarizeAccounts,
  validateDraft,
  yesNo,
  type Account,
  type AccountDraft,
  type AgentFilter,
} from "./agents";
import { useAgentsStore } from "./agentsStore";

const FILTERS: { id: AgentFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "available", label: "Available" },
  { id: "unavailable", label: "Not detected" },
];

/** One row in the list rail: status glyph, name, provider/model meta, ready dot. */
function AccountRow({
  account,
  selected,
  onSelect,
}: {
  account: Account;
  selected: boolean;
  onSelect: (label: string) => void;
}) {
  const status = deriveStatus(account);
  const provider = findProvider(account.providerId);
  return (
    <button
      type="button"
      className={
        (selected ? "rev-row is-on" : "rev-row") + (account.usable ? "" : " is-off")
      }
      onClick={() => onSelect(account.label)}
      data-testid="agents-row"
    >
      <span className={`agent-status-glyph ${STATUS_GLYPH_CLASS[status]}`}>
        {STATUS_GLYPH[status]}
      </span>
      <div className="rev-row-main">
        <div className="rev-row-title">{account.label}</div>
        <div className="rev-row-meta">
          <span>{provider ? provider.name : account.name}</span>
          {account.model ? <span className="rev-num">{account.model}</span> : null}
          <span className="mini-tag">{STATUS_TAG[status]}</span>
          <span className="mini-tag">{account.registered ? "registered" : "detected"}</span>
        </div>
      </div>
      <span className={account.usable ? "ready-dot is-on" : "ready-dot"} />
    </button>
  );
}

/** The registration drawer: provider chips, auth-mode-aware fields, validation. */
function RegisterDrawer() {
  const accounts = useAgentsStore((state) => state.accounts);
  const providerId = useAgentsStore((state) => state.draftProviderId);
  const label = useAgentsStore((state) => state.draftLabel);
  const configDir = useAgentsStore((state) => state.draftConfigDir);
  const apiKey = useAgentsStore((state) => state.draftApiKey);
  const model = useAgentsStore((state) => state.draftModel);
  const force = useAgentsStore((state) => state.draftForce);
  const pickProvider = useAgentsStore((state) => state.pickProvider);
  const setDraftLabel = useAgentsStore((state) => state.setDraftLabel);
  const setDraftConfigDir = useAgentsStore((state) => state.setDraftConfigDir);
  const setDraftApiKey = useAgentsStore((state) => state.setDraftApiKey);
  const setDraftModel = useAgentsStore((state) => state.setDraftModel);
  const toggleDraftForce = useAgentsStore((state) => state.toggleDraftForce);
  const submitRegister = useAgentsStore((state) => state.submitRegister);
  const cancelRegister = useAgentsStore((state) => state.cancelRegister);

  const provider = providerId ? findProvider(providerId) : undefined;
  const providerSlug = provider?.id.replace(/-api$/, "") ?? "codex";
  const labelPlaceholder = provider?.id === "claude-code" ? "claude-work" : `${providerSlug}-work`;
  const configDirPlaceholder = provider?.id === "claude-code" ? "~/.claude" : `~/.${providerSlug}`;
  const draft: AccountDraft = { providerId, label, configDir, apiKey, model, force };
  const error = validateDraft(draft, accounts);
  const valid = error === null;

  return (
    <div className="rev-create" data-testid="agents-register">
      <div className="rev-create-head">Register agent</div>

      <div className="agent-auth-field">
        <label>Provider</label>
        <div className="agent-provider-grid opt-row">
          {PROVIDERS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={providerId === option.id ? "opt is-pick" : "opt"}
              onClick={() => pickProvider(option.id)}
            >
              <span className="agent-provider-avatar" style={{ background: option.color }}>
                {option.initials}
              </span>
              {option.name}
            </button>
          ))}
        </div>
      </div>

      <div className="agent-auth-field">
        <label>Label</label>
        <input
          className="field-input"
          placeholder={labelPlaceholder}
          value={label}
          onChange={(event) => setDraftLabel(event.target.value)}
          data-testid="agents-register-label"
        />
      </div>

      {provider?.authMode === "subscription" ? (
        <div className="agent-auth-field">
          <label>Config dir</label>
          <input
            className="field-input is-mono"
            placeholder={configDirPlaceholder}
            value={configDir}
            onChange={(event) => setDraftConfigDir(event.target.value)}
            data-testid="agents-register-config"
          />
        </div>
      ) : null}

      {provider?.authMode === "api-key" ? (
        <div className="agent-auth-field">
          <label>API key</label>
          <input
            className="field-input is-mono"
            type="password"
            placeholder="sk-…"
            value={apiKey}
            onChange={(event) => setDraftApiKey(event.target.value)}
            data-testid="agents-register-apikey"
          />
        </div>
      ) : null}

      <div className="agent-auth-field">
        <label>Model (optional)</label>
        <input
          className="field-input is-mono"
          placeholder={provider ? provider.modelPlaceholder : "gpt-5.6-luna"}
          list={provider?.modelOptions?.length ? "agent-model-options" : undefined}
          value={model}
          onChange={(event) => setDraftModel(event.target.value)}
          data-testid="agents-register-model"
        />
        {provider?.modelOptions?.length ? (
          <datalist id="agent-model-options">
            {provider.modelOptions.map((modelId) => (
              <option key={modelId} value={modelId} />
            ))}
          </datalist>
        ) : null}
      </div>

      <label className="agent-force">
        <input type="checkbox" checked={force} onChange={toggleDraftForce} />
        Force (skip login / register without auth)
      </label>

      {error ? <div className="agent-draft-error">{error}</div> : null}

      <div className="rev-create-actions">
        <button
          className="btn btn-brand"
          type="button"
          onClick={submitRegister}
          disabled={!valid}
          data-testid="agents-register-submit"
        >
          Register
        </button>
        <button className="btn" type="button" onClick={cancelRegister}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The detail pane: full info rows for the selected account + affordances. */
function AccountDetail({ account }: { account: Account }) {
  const remove = useAgentsStore((state) => state.remove);
  const test = useAgentsStore((state) => state.test);

  const status = deriveStatus(account);
  const provider = findProvider(account.providerId);

  return (
    <div className="rev-detail-scroll" data-testid="agents-detail">
      <div className="rev-detail-head">
        <div className="rev-detail-title">{account.label}</div>
        <div className="rev-detail-actions">
          {account.usable ? (
            <button className="btn" type="button" onClick={() => test(account.label)}>
              Test
            </button>
          ) : null}
          {account.registered ? (
            <button className="btn btn-deny" type="button" onClick={() => remove(account.label)}>
              Remove
            </button>
          ) : null}
        </div>
      </div>

      <div className="rev-detail-meta">
        <span className={`state-badge ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>
        <span className="mini-tag">{provider ? provider.name : account.name}</span>
        <span className="mini-tag">{account.registered ? "registered" : "detected"}</span>
      </div>

      <div className="agent-kv-grid">
        <span className="kv">
          Status <b>{STATUS_LABEL[status]}</b>
        </span>
        <span className="kv">
          Model <b>{account.model || "-"}</b>
        </span>
        <span className="kv">
          Roles
          {account.roles.length > 0 ? (
            <span className="agent-roles">
              {account.roles.map((role) => (
                <span className="agent-role-tag" key={role}>
                  {role[0].toUpperCase() + role.slice(1)}
                </span>
              ))}
            </span>
          ) : (
            <b>-</b>
          )}
        </span>
        <span className="kv">
          Command <b className="vcs-mono">{account.command || "-"}</b>
        </span>
        <span className="kv">
          Binary <b className="vcs-mono">{account.binary || "-"}</b>
        </span>
        <span className="kv">
          Auth <b>{yesNo(account.hasAuth)}</b>
        </span>
        <span className="kv">
          API Key <b>{yesNo(account.hasAPIKey)}</b>
        </span>
        {account.configDir ? (
          <span className="kv">
            Config dir <b className="vcs-mono">{account.configDir}</b>
          </span>
        ) : null}
      </div>

      <div className="rev-row-meta">Roles: {formattedRoles(account.roles)}</div>
    </div>
  );
}

/** The full agents registry: a filtered account list left, account detail right. */
export function AgentsCanvas() {
  const accounts = useAgentsStore((state) => state.accounts);
  const filter = useAgentsStore((state) => state.filter);
  const registering = useAgentsStore((state) => state.registering);
  const setFilter = useAgentsStore((state) => state.setFilter);
  const openRegister = useAgentsStore((state) => state.openRegister);
  const refresh = useAgentsStore((state) => state.refresh);
  const load = useAgentsStore((state) => state.load);
  const select = useAgentsStore((state) => state.select);
  const selected = useAgentsStore(
    (state) => state.accounts.find((account) => account.label === state.selectedLabel) ?? null,
  );

  // Hydrate the live account list from the `listAccounts` gateway RPC on mount,
  // then keep it fresh in local mode (the RPC is pull-only — an account added
  // out-of-band via `smithers agents` is otherwise never pushed here). A failed
  // pull is swallowed: the list simply stays as-is rather than throwing.
  const reload = useCallback(() => load().catch(() => undefined), [load]);
  useEffect(() => {
    reload();
  }, [reload]);
  useLocalModeRefetch(reload);

  const summary = summarizeAccounts(accounts);
  // Apply the filter, then split into Available / Not-detected groups.
  const shown =
    filter === "all"
      ? orderAccounts(accounts)
      : filter === "available"
        ? accounts.filter((account) => account.usable)
        : accounts.filter((account) => !account.usable);
  const available = shown.filter((account) => account.usable);
  const unavailable = shown.filter((account) => !account.usable);

  return (
    <section className="surface agents-canvas" data-testid="agents-canvas">
      <header className="surface-head">
        <span className="surface-title">Agents</span>
        <span className="surface-sub">
          {summary.available} available · {summary.unavailable} not detected
        </span>
        <div className="seg" data-testid="agents-filter">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={filter === option.id ? "is-on" : ""}
              onClick={() => setFilter(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button className="btn" type="button" onClick={refresh} data-testid="agents-refresh">
          Refresh
        </button>
        <button className="btn btn-brand" type="button" onClick={openRegister}>
          Register agent
        </button>
      </header>

      <div className="rev-body">
        <div className="rev-list">
          {registering ? <RegisterDrawer /> : null}
          {shown.length > 0 ? (
            <>
              {available.length > 0 ? (
                <>
                  <div className="agent-group-head">Available</div>
                  {available.map((account) => (
                    <AccountRow
                      key={account.label}
                      account={account}
                      selected={selected?.label === account.label}
                      onSelect={select}
                    />
                  ))}
                </>
              ) : null}
              {unavailable.length > 0 ? (
                <>
                  <div className="agent-group-head">Not detected</div>
                  {unavailable.map((account) => (
                    <AccountRow
                      key={account.label}
                      account={account}
                      selected={selected?.label === account.label}
                      onSelect={select}
                    />
                  ))}
                </>
              ) : null}
            </>
          ) : (
            <div className="rev-empty">No agents here.</div>
          )}
        </div>

        <div className="rev-detail">
          {selected ? (
            <AccountDetail account={selected} />
          ) : (
            <div className="rev-detail-empty">Select an agent.</div>
          )}
        </div>
      </div>
    </section>
  );
}

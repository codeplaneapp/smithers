import { useEffect } from "react";
import { openSurface } from "../app/navigation";
import type { Surface } from "../app/Surface";
import { AGENTS } from "./agents";
import { useAgentsStore } from "./agentsStore";

/**
 * The agents-registry surface kind. The integrator adds `{ kind: "agents" }` to
 * the central `Surface` union + the `openSurface` switch; until then this cast
 * keeps the card compiling without editing the DO-NOT-TOUCH navigation files.
 */
function openAgentsRegistry(): void {
  openSurface({ kind: "agents" } as unknown as Surface);
}

function AgentIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 2a5 5 0 0 1 5 5v2a5 5 0 0 1-10 0V7a5 5 0 0 1 5-5zM4 21a8 8 0 0 1 16 0"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The agents/providers card: one row per provider with availability + auth. */
export function AgentsCard() {
  // The headline count comes from the LIVE registry (the `listAccounts` RPC,
  // hydrated into the store): how many registered accounts are usable vs not.
  // The provider rows below stay the static catalog glance (config, not state).
  const accounts = useAgentsStore((state) => state.accounts);
  const ready = accounts.filter((account) => account.usable).length;
  const openRegister = useAgentsStore((state) => state.openRegister);
  const load = useAgentsStore((state) => state.load);

  // Hydrate the live count on mount (the card can render before the canvas is
  // ever opened). A failed pull leaves the prior list as-is.
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  return (
    <article className="list-card" data-testid="agents-card">
      <header className="card-head">
        <span className="card-icon">
          <AgentIcon />
        </span>
        <div className="card-headings">
          <div className="card-title">Agents &amp; providers</div>
          <div className="card-sub" data-testid="agents-card-sub">
            {ready} ready · {accounts.length - ready} not detected
          </div>
        </div>
        <button className="card-link" type="button" onClick={openAgentsRegistry}>
          Open registry ›
        </button>
      </header>
      <div className="card-body card-body-flush">
        {AGENTS.map((agent) => (
          <div className={agent.available ? "list-row" : "list-row is-off"} key={agent.id}>
            <span className="avatar" style={{ background: agent.color }}>
              {agent.initials}
            </span>
            <div className="list-text">
              <div className="list-name">{agent.name}</div>
              <div className="list-meta">{agent.detail}</div>
            </div>
            <div className="list-tags">
              {agent.auth ? (
                <span className="mini-tag is-ok">{agent.auth}</span>
              ) : (
                <span className="mini-tag">no key</span>
              )}
              <span className={agent.available ? "ready-dot is-on" : "ready-dot"} />
            </div>
          </div>
        ))}
      </div>
      <footer className="card-foot">
        <button
          className="btn btn-brand"
          type="button"
          onClick={() => {
            openRegister();
            openAgentsRegistry();
          }}
        >
          Register
        </button>
      </footer>
    </article>
  );
}

import { DEFAULT_AGENTS, useSettingsStore } from "./settingsStore";

/**
 * Minimal Settings panel rendered in the overlay/split host. Mock: the only knob
 * is the **default agent** selector (Product spec §5 — codex by default).
 * Choosing a different agent persists to the store and fires the ephemeral
 * cache-warning notice.
 */
export function SettingsOverlay() {
  const defaultAgent = useSettingsStore((s) => s.defaultAgent);
  const setDefaultAgent = useSettingsStore((s) => s.setDefaultAgent);

  return (
    <div className="settings-panel" data-testid="settings-panel">
      <section className="settings-group">
        <h3 className="settings-group-title">Default agent</h3>
        <p className="settings-group-hint">
          The orchestration agent that owns the chat and launches workflows. Changing it may start a new session.
        </p>
        <div className="settings-agents" role="radiogroup">
          {DEFAULT_AGENTS.map((agent) => (
            <button
              aria-checked={agent.id === defaultAgent}
              className={agent.id === defaultAgent ? "settings-agent settings-agent--active" : "settings-agent"}
              data-testid="settings-agent"
              key={agent.id}
              onClick={() => setDefaultAgent(agent.id)}
              role="radio"
              type="button"
            >
              {agent.label}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

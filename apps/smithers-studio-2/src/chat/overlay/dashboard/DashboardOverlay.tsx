import type { Dashboard, DashboardSection, DashboardTone } from "./Dashboard";

/** Run-state / severity tokens — COLOR = state only, no invented colors (DESIGN.md). */
const TONE_COLOR: Record<DashboardTone, string> = {
  neutral: "var(--text-secondary)",
  running: "var(--accent)",
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--danger)",
  accent: "var(--accent)",
};

function toneColor(tone: DashboardTone | undefined): string {
  return TONE_COLOR[tone ?? "neutral"];
}

/**
 * The default view for a prototype `dashboard` overlay (triage dashboard, run
 * board, memory, …). SEAM: fed from a `Dashboard` (seeded today; later the real
 * Studio surface renders here behind the same overlay host). Renders titled
 * sections of stat tiles, status rows, and tables with run-state-colored values.
 */
export function DashboardOverlay({ dashboard }: { dashboard: Dashboard }) {
  return (
    <div className="overlay-dash" data-testid="overlay-dashboard">
      <p className="overlay-dash-caption">{dashboard.caption}</p>
      {dashboard.sections.map((section) => (
        <Section key={section.heading} section={section} />
      ))}
    </div>
  );
}

function Section({ section }: { section: DashboardSection }) {
  return (
    <section className="overlay-dash-section">
      <h3 className="overlay-dash-heading">{section.heading}</h3>
      {section.kind === "stats" && (
        <div className="overlay-dash-stats">
          {section.tiles.map((tile) => (
            <div className="overlay-dash-stat" key={tile.label}>
              <span className="overlay-dash-stat-value" style={{ color: toneColor(tile.tone) }}>
                {tile.value}
              </span>
              <span className="overlay-dash-stat-label">{tile.label}</span>
              {tile.detail && <span className="overlay-dash-stat-detail">{tile.detail}</span>}
            </div>
          ))}
        </div>
      )}
      {section.kind === "status-list" && (
        <ul className="overlay-dash-rows">
          {section.rows.map((row) => (
            <li className="overlay-dash-row" key={row.title}>
              <span className="overlay-dash-row-dot" style={{ color: toneColor(row.tone) }}>
                ●
              </span>
              <span className="overlay-dash-row-main">
                <span className="overlay-dash-row-title">{row.title}</span>
                <span className="overlay-dash-row-detail">{row.detail}</span>
              </span>
              <span className="overlay-dash-row-status" style={{ color: toneColor(row.tone) }}>
                {row.status}
              </span>
            </li>
          ))}
        </ul>
      )}
      {section.kind === "table" && (
        <table className="overlay-dash-table">
          <thead>
            <tr>
              {section.columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {section.rows.map((row, rowIndex) => (
              // Rows are static seed data; index keying is stable here.
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td
                    className={cell.mono ? "overlay-dash-cell-mono" : undefined}
                    key={cellIndex}
                    style={{ color: toneColor(cell.tone) }}
                  >
                    {cell.text}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

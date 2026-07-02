/** @jsxImportSource react */
import { useState } from "react";
import { asString, fmtTime, statusClass, type TicketRow } from "./ddd-shared";

export type TicketsTabProps = {
  tickets: TicketRow[];
  loading: boolean;
};

function ticketTitle(ticket: TicketRow): string {
  const content = asString(ticket.content);
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() || ticket.path;
}

function TicketModal({ ticket, onClose }: { ticket: TicketRow; onClose: () => void }) {
  const featureTitle = asString(ticket.featureTitle) || asString(ticket.featureId);
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="modal" role="dialog" aria-modal="true" data-testid="ddd-ticket-detail" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <span className="eyebrow">{asString(ticket.kind) || "ticket"}</span>
            <h2>{ticketTitle(ticket)}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close">x</button>
        </div>
        <div className="meta-row">
          {ticket.status ? <span className={`badge ${statusClass(asString(ticket.status))}`}>{asString(ticket.status)}</span> : null}
          {featureTitle ? <span className="pill">{featureTitle}</span> : null}
          <span className="pill">{ticket.path}</span>
          {ticket.updatedAtMs ? <span className="pill">{fmtTime(ticket.updatedAtMs)}</span> : null}
        </div>
        <pre className="source">{asString(ticket.content) || "No detail recorded for this ticket."}</pre>
      </section>
    </div>
  );
}

export function TicketsTab(props: TicketsTabProps) {
  const { tickets, loading } = props;
  const [selected, setSelected] = useState<TicketRow | null>(null);
  return (
    <div className="scroll pane" data-testid="ddd-tickets-tab">
      <section className="card">
        <div className="card-head">
          <h2>Tickets created</h2>
          <span className={`badge ${tickets.length ? "ok" : "muted"}`}>{tickets.length || (loading ? "…" : 0)}</span>
        </div>
        {tickets.length ? (
          tickets.map((ticket) => (
            <button
              type="button"
              className="slot ticket-row"
              key={ticket.path}
              data-testid="ddd-ticket"
              onClick={() => setSelected(ticket)}
            >
              <div className="slot-title">
                <strong>{ticketTitle(ticket)}</strong>
                {ticket.status ? <span className={`badge ${statusClass(asString(ticket.status))}`}>{asString(ticket.status)}</span> : null}
              </div>
              <div className="meta-row">
                <span className="pill">{ticket.kind ?? "ticket"}</span>
                <span className="pill">{ticket.path}</span>
                {ticket.updatedAtMs ? <span className="pill">{fmtTime(ticket.updatedAtMs)}</span> : null}
              </div>
            </button>
          ))
        ) : (
          <p>{loading ? "Loading tickets…" : "No tickets yet. Triage should materialize selected work into tickets before agents run."}</p>
        )}
      </section>
      {selected ? <TicketModal ticket={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

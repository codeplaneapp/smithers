/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { asString, fmtTime, formatStatus, statusClass, type TicketRow } from "./ddd-shared";

export type TicketsTabProps = {
  tickets: TicketRow[];
  loading: boolean;
};

function ticketTitle(ticket: TicketRow): string {
  const content = asString(ticket.content);
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() || ticket.path;
}

function ticketSearchBlob(ticket: TicketRow): string {
  return [
    ticket.path,
    ticket.kind,
    ticket.status,
    ticketTitle(ticket),
    asString(ticket.featureTitle),
    asString(ticket.featureId),
    asString(ticket.content),
  ].filter(Boolean).join(" ").toLowerCase();
}

function uniqueTicketValues(tickets: TicketRow[], field: "kind" | "status"): string[] {
  return [...new Set(tickets.map((ticket) => asString(ticket[field]).trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

type TicketSection = { title: string; body: string[]; items: string[] };

function ticketDetailSections(content: string): TicketSection[] {
  const sections: TicketSection[] = [];
  let current: TicketSection | null = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("# ")) continue;
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      current = { title: heading[1]!.trim(), body: [], items: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("- ")) current.items.push(line.slice(2).trim());
    else if (!/^[A-Za-z][A-Za-z ]+:\s*/.test(line)) current.body.push(line);
  }
  return sections;
}

function TicketDetailBody({ ticket }: { ticket: TicketRow }) {
  const content = asString(ticket.content);
  const sections = ticketDetailSections(content);
  if (sections.length === 0) return <p>No detail recorded for this ticket.</p>;
  return (
    <div className="ticket-detail-body">
      {sections.map((section) => (
        <section className="ticket-section" key={section.title}>
          <h3>{section.title}</h3>
          {section.body.map((line, index) => <p key={`${section.title}:body:${index}`}>{line}</p>)}
          {section.items.length ? (
            <ul>
              {section.items.map((item, index) => <li key={`${section.title}:item:${index}`}>{item}</li>)}
            </ul>
          ) : null}
        </section>
      ))}
    </div>
  );
}

function TicketModal({ ticket, onClose }: { ticket: TicketRow; onClose: () => void }) {
  const featureTitle = asString(ticket.featureTitle) || asString(ticket.featureId);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
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
          {ticket.status ? <span className={`badge ${statusClass(asString(ticket.status))}`}>{formatStatus(asString(ticket.status))}</span> : null}
          {featureTitle ? <span className="pill">{featureTitle}</span> : null}
          <span className="pill ticket-path" title={ticket.path}>{ticket.path}</span>
          {ticket.updatedAtMs ? <span className="pill">{fmtTime(ticket.updatedAtMs)}</span> : null}
        </div>
        <TicketDetailBody ticket={ticket} />
      </section>
    </div>
  );
}

export function TicketsTab(props: TicketsTabProps) {
  const { tickets, loading } = props;
  const [selected, setSelected] = useState<TicketRow | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const statuses = useMemo(() => uniqueTicketValues(tickets, "status"), [tickets]);
  const kinds = useMemo(() => uniqueTicketValues(tickets, "kind"), [tickets]);
  const filteredTickets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tickets.filter((ticket) => {
      if (statusFilter !== "all" && asString(ticket.status) !== statusFilter) return false;
      if (kindFilter !== "all" && asString(ticket.kind) !== kindFilter) return false;
      return !needle || ticketSearchBlob(ticket).includes(needle);
    });
  }, [tickets, query, statusFilter, kindFilter]);
  const filtersActive = query.trim().length > 0 || statusFilter !== "all" || kindFilter !== "all";

  return (
    <div className="scroll pane" data-testid="ddd-tickets-tab">
      <section className="card">
        <div className="card-head">
          <h2>Tickets</h2>
          <span className={`badge ${filteredTickets.length ? "ok" : "muted"}`}>{loading ? "Loading" : `${filteredTickets.length} of ${tickets.length}`}</span>
        </div>
        <div className="filters" role="search" aria-label="Ticket filters">
          <label className="filter-field">
            <span>Search</span>
            <input
              className="search-input"
              type="search"
              value={query}
              placeholder="Title, path, feature, status"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <label className="filter-field">
            <span>Status</span>
            <select className="select" value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value)}>
              <option value="all">All statuses</option>
              {statuses.map((status) => <option key={status} value={status}>{formatStatus(status)}</option>)}
            </select>
          </label>
          <label className="filter-field">
            <span>Kind</span>
            <select className="select" value={kindFilter} onChange={(event) => setKindFilter(event.currentTarget.value)}>
              <option value="all">All kinds</option>
              {kinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
            </select>
          </label>
          {filtersActive ? (
            <button className="button" type="button" onClick={() => { setQuery(""); setStatusFilter("all"); setKindFilter("all"); }}>
              Clear
            </button>
          ) : null}
        </div>
        {filteredTickets.length ? (
          filteredTickets.map((ticket) => (
            <button
              type="button"
              className="slot ticket-row"
              key={ticket.path}
              data-testid="ddd-ticket"
              onClick={() => setSelected(ticket)}
            >
              <div className="slot-title">
                <strong>{ticketTitle(ticket)}</strong>
                {ticket.status ? <span className={`badge ${statusClass(asString(ticket.status))}`}>{formatStatus(asString(ticket.status))}</span> : null}
              </div>
              <div className="meta-row">
                <span className="pill">{ticket.kind ?? "ticket"}</span>
                <span className="pill ticket-path" title={ticket.path}>{ticket.path}</span>
                {ticket.updatedAtMs ? <span className="pill">{fmtTime(ticket.updatedAtMs)}</span> : null}
              </div>
            </button>
          ))
        ) : (
          <p>{loading ? "Loading tickets…" : filtersActive ? "No tickets match the current filters." : "No tickets yet. Triage should materialize selected work into tickets before agents run."}</p>
        )}
      </section>
      {selected ? <TicketModal ticket={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

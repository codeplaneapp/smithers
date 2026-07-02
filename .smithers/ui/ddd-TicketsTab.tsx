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
type TicketDetail = { metadata: Record<string, string>; sections: TicketSection[] };

const METADATA_ORDER = ["Status", "Kind", "Severity", "Run", "Slot", "Agent", "Task type", "Feature", "Feature title", "Feature status", "File"];

function parseMetadataLine(line: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const part of line.split(/\s+·\s+/)) {
    const match = part.match(/^([A-Za-z][A-Za-z ]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!.trim();
    const value = match[2]!.trim();
    if (value) entries.push([key, value]);
  }
  return entries;
}

function ticketDetail(content: string): TicketDetail {
  const sections: TicketSection[] = [];
  const metadata: Record<string, string> = {};
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
    if (!current) {
      for (const [key, value] of parseMetadataLine(line)) metadata[key] = value;
      continue;
    }
    if (line.startsWith("- ")) current.items.push(line.slice(2).trim());
    else if (!/^[A-Za-z][A-Za-z ]+:\s*/.test(line)) current.body.push(line);
  }
  return { metadata, sections };
}

function metadataEntries(metadata: Record<string, string>): Array<[string, string]> {
  const known = METADATA_ORDER.filter((key) => metadata[key]).map((key): [string, string] => [key, metadata[key]!]);
  const rest = Object.entries(metadata)
    .filter(([key]) => !METADATA_ORDER.includes(key))
    .sort(([left], [right]) => left.localeCompare(right));
  return [...known, ...rest];
}

function metadataForTicket(ticket: TicketRow): Record<string, string> {
  const detail = ticketDetail(asString(ticket.content));
  const metadata = { ...detail.metadata };
  const featureId = asString(ticket.featureId);
  const featureTitle = asString(ticket.featureTitle);
  if (featureId && !metadata.Feature) metadata.Feature = featureId;
  if (featureTitle && !metadata["Feature title"]) metadata["Feature title"] = featureTitle;
  if (asString(ticket.kind) && !metadata.Kind) metadata.Kind = asString(ticket.kind);
  if (asString(ticket.status) && !metadata.Status) metadata.Status = asString(ticket.status);
  return metadata;
}

function ticketFeatureLabel(ticket: TicketRow, metadata: Record<string, string> = metadataForTicket(ticket)): string {
  return asString(ticket.featureTitle) || metadata["Feature title"] || metadata.Feature || asString(ticket.featureId);
}

function ticketFileLabel(metadata: Record<string, string>): string {
  return metadata.File ?? "";
}

function TicketDetailBody({ ticket }: { ticket: TicketRow }) {
  const content = asString(ticket.content);
  const detail = ticketDetail(content);
  const entries = metadataEntries(metadataForTicket(ticket));
  if (detail.sections.length === 0 && entries.length === 0) return <p>No detail recorded for this ticket.</p>;
  return (
    <div className="ticket-detail-body">
      {entries.length ? (
        <section className="ticket-section">
          <h3>Details</h3>
          <div className="ticket-meta-grid">
            {entries.map(([key, value]) => (
              <div className="ticket-meta" key={key}>
                <span>{key}</span>
                <strong title={value}>{key === "Status" ? formatStatus(value) : value}</strong>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {detail.sections.map((section) => (
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
  const metadata = metadataForTicket(ticket);
  const featureTitle = ticketFeatureLabel(ticket, metadata);
  const file = ticketFileLabel(metadata);
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
          {file ? <span className="pill ticket-path" title={file}>{file}</span> : null}
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
            (() => {
              const metadata = metadataForTicket(ticket);
              const feature = ticketFeatureLabel(ticket, metadata);
              const file = ticketFileLabel(metadata);
              return (
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
                {feature ? <span className="pill">{feature}</span> : null}
                {file ? <span className="pill ticket-path" title={file}>{file}</span> : null}
                <span className="pill ticket-path" title={ticket.path}>{ticket.path}</span>
                {ticket.updatedAtMs ? <span className="pill">{fmtTime(ticket.updatedAtMs)}</span> : null}
              </div>
            </button>
              );
            })()
          ))
        ) : (
          <p>{loading ? "Loading tickets…" : filtersActive ? "No tickets match the current filters." : "No tickets yet. Triage should materialize selected work into tickets before agents run."}</p>
        )}
      </section>
      {selected ? <TicketModal ticket={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

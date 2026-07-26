/** @jsxImportSource react */
import { useMemo, useRef, useState } from "react";
import {
  MarkdownPreview,
  asString,
  fmtTime,
  formatCount,
  formatPriority,
  formatSeverity,
  formatStatus,
  formatTicketKind,
  priorityRank,
  severityClass,
  severityRank,
  statusClass,
  ticketRiskClass,
  useDialogFocusTrap,
  type TicketRow,
} from "./ddd-shared";

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
    asString(ticket.featureTitle ?? ticket.feature_title),
    asString(ticket.featureId ?? ticket.feature_id),
    asString(ticket.priority),
    asString(ticket.severity),
    asString(ticket.content),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function uniqueTicketValues(tickets: TicketRow[], field: "kind" | "status"): string[] {
  return [...new Set(tickets.map((ticket) => asString(ticket[field]).trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function uniqueTicketMetadataValues(tickets: TicketRow[], key: "Priority" | "Severity"): string[] {
  return [...new Set(tickets.map((ticket) => metadataForTicket(ticket)[key]?.trim()).filter(Boolean))].sort(
    (left, right) => {
      if (key === "Priority") return priorityRank(left) - priorityRank(right) || left.localeCompare(right);
      return severityRank(left) - severityRank(right) || left.localeCompare(right);
    },
  );
}

type TicketSection = { title: string; body: string[]; items: string[] };
type TicketDetail = { metadata: Record<string, string>; plainBody: string[]; sections: TicketSection[] };

const METADATA_ORDER = [
  "Status",
  "Kind",
  "Priority",
  "Severity",
  "Run",
  "Slot",
  "Agent",
  "Task type",
  "Feature",
  "Feature title",
  "Feature status",
  "File",
];

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
  const plainBody: string[] = [];
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
      const metadataEntries = parseMetadataLine(line);
      if (metadataEntries.length > 0 && line.split(/\s+·\s+/).every((part) => parseMetadataLine(part).length === 1)) {
        for (const [key, value] of metadataEntries) metadata[key] = value;
      } else {
        plainBody.push(line);
      }
      continue;
    }
    if (line.startsWith("- ")) current.items.push(line.slice(2).trim());
    else current.body.push(line);
  }
  return { metadata, plainBody, sections };
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
  const featureId = asString(ticket.featureId ?? ticket.feature_id);
  const featureTitle = asString(ticket.featureTitle ?? ticket.feature_title);
  const priority = asString(ticket.priority);
  const severity = asString(ticket.severity);
  if (featureId && !metadata.Feature) metadata.Feature = featureId;
  if (featureTitle && !metadata["Feature title"]) metadata["Feature title"] = featureTitle;
  if (priority && !metadata.Priority) metadata.Priority = priority;
  if (severity && !metadata.Severity) metadata.Severity = severity;
  if (asString(ticket.kind) && !metadata.Kind) metadata.Kind = asString(ticket.kind);
  if (asString(ticket.status) && !metadata.Status) metadata.Status = asString(ticket.status);
  return metadata;
}

function ticketFeatureLabel(ticket: TicketRow, metadata: Record<string, string> = metadataForTicket(ticket)): string {
  return (
    asString(ticket.featureTitle ?? ticket.feature_title) ||
    metadata["Feature title"] ||
    metadata.Feature ||
    asString(ticket.featureId ?? ticket.feature_id)
  );
}

function ticketFileLabel(metadata: Record<string, string>): string {
  return metadata.File ?? "";
}

/**
 * The ticket's markdown body with the leading `# Title` and the metadata line
 * removed (both are already shown in the modal head + Details grid). What's left
 * is real markdown — nested lists, code fences, blockquotes, links — that the
 * old line-by-line `<p>`/`<li>` parser flattened into a wall of text.
 */
function ticketBodyMarkdown(content: string): string {
  const lines = content.split(/\r?\n/);
  const kept: string[] = [];
  let sawHeading = false;
  let droppedTitle = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!sawHeading) {
      if (!droppedTitle && line.startsWith("# ")) {
        droppedTitle = true;
        continue;
      }
      if (line.startsWith("## ")) {
        sawHeading = true;
        kept.push(rawLine);
        continue;
      }
      // A pure metadata line (every `·`-separated part is a single `Key: value`).
      if (
        line &&
        parseMetadataLine(line).length > 0 &&
        line.split(/\s+·\s+/).every((part) => parseMetadataLine(part).length === 1)
      )
        continue;
      if (line || kept.length) kept.push(rawLine);
    } else {
      kept.push(rawLine);
    }
  }
  return kept.join("\n").trim();
}

function TicketDetailBody({ ticket, onOpenLink }: { ticket: TicketRow; onOpenLink?: (href: string) => void }) {
  const content = asString(ticket.content);
  const body = ticketBodyMarkdown(content);
  const entries = metadataEntries(metadataForTicket(ticket));
  if (!body && entries.length === 0) return <p className="empty">No detail recorded for this ticket.</p>;
  return (
    <div className="ticket-detail-body">
      {entries.length ? (
        <section className="ticket-section">
          <h3>Details</h3>
          <div className="ticket-meta-grid">
            {entries.map(([key, value]) => (
              <div className="ticket-meta" key={key}>
                <span>{key}</span>
                <strong title={value}>
                  {key === "Status"
                    ? formatStatus(value)
                    : key === "Kind"
                      ? formatTicketKind(value)
                      : key === "Priority"
                        ? formatPriority(value)
                        : key === "Severity"
                          ? formatSeverity(value)
                          : value}
                </strong>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {body ? (
        <section className="ticket-section ticket-body">
          <MarkdownPreview markdown={body} onLinkClick={onOpenLink} />
        </section>
      ) : null}
    </div>
  );
}

function TicketModal({ ticket, onClose }: { ticket: TicketRow; onClose: () => void }) {
  const metadata = metadataForTicket(ticket);
  const featureTitle = ticketFeatureLabel(ticket, metadata);
  const file = ticketFileLabel(metadata);
  const priority = metadata.Priority;
  const severity = metadata.Severity;
  const modalRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useDialogFocusTrap({ containerRef: modalRef, initialFocusRef: closeRef, onClose });
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        ref={modalRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ddd-ticket-detail-title"
        tabIndex={-1}
        data-testid="ddd-ticket-detail"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow">{formatTicketKind(asString(ticket.kind) || "ticket")}</span>
            <h2 id="ddd-ticket-detail-title">{ticketTitle(ticket)}</h2>
          </div>
          <button ref={closeRef} className="icon-button" type="button" onClick={onClose} aria-label="Close">
            x
          </button>
        </div>
        <div className="meta-row">
          {ticket.status ? (
            <span className={`badge ${statusClass(asString(ticket.status))}`}>
              {formatStatus(asString(ticket.status))}
            </span>
          ) : null}
          {priority ? (
            <span className={`badge ${ticketRiskClass(priority, severity)}`}>{formatPriority(priority)}</span>
          ) : null}
          {severity ? <span className={`badge ${severityClass(severity)}`}>{formatSeverity(severity)}</span> : null}
          {featureTitle ? <span className="pill">{featureTitle}</span> : null}
          {file ? (
            <span className="pill ticket-path" title={file}>
              {file}
            </span>
          ) : null}
          <span className="pill ticket-path" title={ticket.path}>
            {ticket.path}
          </span>
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
  const [severityFilter, setSeverityFilter] = useState("all");
  const [sortMode, setSortMode] = useState<"risk" | "updated" | "title">("risk");
  const statuses = useMemo(() => uniqueTicketValues(tickets, "status"), [tickets]);
  const kinds = useMemo(() => uniqueTicketValues(tickets, "kind"), [tickets]);
  const severities = useMemo(() => uniqueTicketMetadataValues(tickets, "Severity"), [tickets]);
  const filteredTickets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = tickets
      .map((ticket, index) => ({ ticket, index }))
      .filter(({ ticket }) => {
        const metadata = metadataForTicket(ticket);
        if (statusFilter !== "all" && asString(ticket.status) !== statusFilter) return false;
        if (kindFilter !== "all" && asString(ticket.kind) !== kindFilter) return false;
        if (severityFilter !== "all" && metadata.Severity !== severityFilter) return false;
        return !needle || ticketSearchBlob(ticket).includes(needle);
      });
    return [...filtered]
      .sort((left, right) => {
        if (sortMode === "updated")
          return (
            Number(right.ticket.updatedAtMs ?? 0) - Number(left.ticket.updatedAtMs ?? 0) || left.index - right.index
          );
        if (sortMode === "title")
          return ticketTitle(left.ticket).localeCompare(ticketTitle(right.ticket)) || left.index - right.index;
        const leftMeta = metadataForTicket(left.ticket);
        const rightMeta = metadataForTicket(right.ticket);
        return (
          Math.min(priorityRank(leftMeta.Priority), severityRank(leftMeta.Severity)) -
            Math.min(priorityRank(rightMeta.Priority), severityRank(rightMeta.Severity)) ||
          severityRank(leftMeta.Severity) - severityRank(rightMeta.Severity) ||
          priorityRank(leftMeta.Priority) - priorityRank(rightMeta.Priority) ||
          Number(right.ticket.updatedAtMs ?? 0) - Number(left.ticket.updatedAtMs ?? 0) ||
          left.index - right.index
        );
      })
      .map(({ ticket }) => ticket);
  }, [tickets, query, statusFilter, kindFilter, severityFilter, sortMode]);
  const filtersActive =
    query.trim().length > 0 || statusFilter !== "all" || kindFilter !== "all" || severityFilter !== "all";
  // At-a-glance backlog health: count tickets by severity (highest-risk first),
  // each chip a one-click facet toggle for that severity.
  const severityCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ticket of tickets) {
      const severity = metadataForTicket(ticket).Severity;
      if (!severity) continue;
      counts.set(severity, (counts.get(severity) ?? 0) + 1);
    }
    return [...counts.entries()].sort(
      ([left], [right]) => severityRank(left) - severityRank(right) || left.localeCompare(right),
    );
  }, [tickets]);

  return (
    <div className="scroll pane" data-testid="ddd-tickets-tab">
      <section className="card">
        <div className="card-head">
          <h2>Tickets</h2>
          <span className={`badge ${filteredTickets.length ? "ok" : "muted"}`}>
            {loading
              ? "Loading"
              : filteredTickets.length === tickets.length
                ? formatCount(tickets.length, "ticket")
                : `${formatCount(filteredTickets.length, "ticket")} of ${formatCount(tickets.length, "ticket")}`}
          </span>
        </div>
        <div className="filters ticket-filters" role="search" aria-label="Ticket filters">
          <label className="filter-field">
            <span>Search</span>
            <input
              className="search-input"
              type="search"
              value={query}
              placeholder="Title, path, feature, status"
              onInput={(event) => setQuery(event.currentTarget.value)}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <label className="filter-field">
            <span>Status</span>
            <select
              className="select"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.currentTarget.value)}
            >
              <option value="all">All statuses</option>
              {statuses.map((status) => (
                <option key={status} value={status}>
                  {formatStatus(status)}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-field">
            <span>Kind</span>
            <select
              className="select"
              value={kindFilter}
              onChange={(event) => setKindFilter(event.currentTarget.value)}
            >
              <option value="all">All kinds</option>
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {formatTicketKind(kind)}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-field">
            <span>Severity</span>
            <select
              className="select"
              value={severityFilter}
              onChange={(event) => setSeverityFilter(event.currentTarget.value)}
            >
              <option value="all">All severities</option>
              {severities.map((severity) => (
                <option key={severity} value={severity}>
                  {formatSeverity(severity)}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-field">
            <span>Sort</span>
            <select
              className="select"
              value={sortMode}
              onChange={(event) => setSortMode(event.currentTarget.value as "risk" | "updated" | "title")}
            >
              <option value="risk">Highest risk</option>
              <option value="updated">Recently updated</option>
              <option value="title">Title</option>
            </select>
          </label>
          {filtersActive ? (
            <button
              className="button"
              type="button"
              onClick={() => {
                setQuery("");
                setStatusFilter("all");
                setKindFilter("all");
                setSeverityFilter("all");
              }}
            >
              Clear
            </button>
          ) : null}
        </div>
        {severityCounts.length ? (
          <div
            className="status-counts ticket-tally"
            data-testid="ddd-ticket-tally"
            role="group"
            aria-label="Filter by severity"
          >
            {severityCounts.map(([severity, count]) => (
              <button
                key={severity}
                type="button"
                className={`badge ${severityClass(severity)} tally-chip${severityFilter === severity ? " is-active" : ""}`}
                aria-pressed={severityFilter === severity}
                onClick={() => setSeverityFilter((current) => (current === severity ? "all" : severity))}
              >
                {count} {formatSeverity(severity)}
              </button>
            ))}
          </div>
        ) : null}
        {filteredTickets.length ? (
          filteredTickets.map((ticket, index) =>
            (() => {
              const metadata = metadataForTicket(ticket);
              const feature = ticketFeatureLabel(ticket, metadata);
              const file = ticketFileLabel(metadata);
              const priority = metadata.Priority;
              const severity = metadata.Severity;
              return (
                <button
                  type="button"
                  className={`slot ticket-row risk-${ticketRiskClass(priority, severity)}`}
                  key={`${ticket.path}:${index}`}
                  data-testid="ddd-ticket"
                  onClick={() => setSelected(ticket)}
                >
                  <div className="slot-title">
                    <strong>{ticketTitle(ticket)}</strong>
                    {ticket.status ? (
                      <span className={`badge ${statusClass(asString(ticket.status))}`}>
                        {formatStatus(asString(ticket.status))}
                      </span>
                    ) : null}
                  </div>
                  <div className="meta-row">
                    <span className="pill">{formatTicketKind(asString(ticket.kind) || "ticket")}</span>
                    {priority ? (
                      <span className={`badge ${ticketRiskClass(priority, severity)}`}>{formatPriority(priority)}</span>
                    ) : null}
                    {severity ? (
                      <span className={`badge ${severityClass(severity)}`}>{formatSeverity(severity)}</span>
                    ) : null}
                    {feature ? <span className="pill">{feature}</span> : null}
                    {file ? (
                      <span className="pill ticket-path" title={file}>
                        {file}
                      </span>
                    ) : null}
                    <span className="pill ticket-path" title={ticket.path}>
                      {ticket.path}
                    </span>
                    {ticket.updatedAtMs ? <span className="pill">{fmtTime(ticket.updatedAtMs)}</span> : null}
                  </div>
                </button>
              );
            })(),
          )
        ) : (
          <p>
            {loading
              ? "Loading tickets..."
              : filtersActive
                ? "No tickets match the current filters."
                : "No tickets yet. Triage should materialize selected work into tickets before agents run."}
          </p>
        )}
      </section>
      {selected ? <TicketModal ticket={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

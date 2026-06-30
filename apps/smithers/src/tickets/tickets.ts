/**
 * The tickets surface: a list of markdown work items the agent reads and edits.
 * Each ticket is a markdown doc with a status; the canvas is a plain markdown
 * editor over a selected ticket. The list is LIVE — `TicketsBridge` pushes the
 * gateway `tickets` collection (the `listTickets` RPC over `_smithers_docs`) into
 * the store; there is NO in-app seed (the gateway is the source of truth).
 *
 * Everything below is pure, so the snippet extractor, search, the status mapper,
 * and the create/update/delete reducers (used for optimistic updates) are
 * unit-tested without a DOM (see ticketsDomain.test.ts).
 */
export type TicketStatus = "todo" | "in-progress" | "done";

/** The ticket statuses the surface renders; the wire `status` is free-form text. */
export const TICKET_STATUSES: readonly TicketStatus[] = ["todo", "in-progress", "done"];

/**
 * Map a free-form wire `status` (`_smithers_docs.status`, `string | null`) onto
 * the three-tone `TicketStatus` the surface renders. An unknown or absent status
 * collapses to `todo` so a live row never strands the badge on an invalid tone.
 */
export function ticketStatusFromWire(status: string | null | undefined): TicketStatus {
  return status === "in-progress" || status === "done" ? status : "todo";
}

/**
 * A relative "updated" label for a ticket's `updatedAtMs`. Buckets: <60s
 * `{n}s ago`, <60m `{n}m ago`, <24h `{n}h ago`, else `{n}d ago`. `now` defaults
 * to the wall clock at call time; pass a fixed anchor for clock-free tests.
 */
export function ticketUpdatedLabel(updatedAtMs: number, now = Date.now()): string {
  const deltaSec = Math.max(0, Math.floor((now - updatedAtMs) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86_400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86_400)}d ago`;
}

/** One markdown work item. `updated` is a static human string like "2d ago". */
export type Ticket = {
  id: string;
  content: string;
  status: TicketStatus;
  updated: string;
};

/** Clip `text` to `maxLength`, appending a single ellipsis when it overflows. */
function truncateSnippet(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const clipped = text.slice(0, Math.max(1, maxLength - 1));
  return `${clipped}…`;
}

/** A `- key: value` line, where the key is a short label (two words or fewer). */
function metadataLine(line: string): boolean {
  if (!line.startsWith("- ")) return false;
  const rest = line.slice(2);
  const colon = rest.indexOf(":");
  if (colon === -1) return false;
  const key = rest.slice(0, colon);
  const keyFields = key.split(" ").filter((part) => part.length > 0);
  return !key.includes(" ") || keyFields.length <= 2;
}

/**
 * The list preview for a ticket. First take the line after a `## Summary` or
 * `## Description` heading; otherwise the first line that is not a heading, a
 * `---` rule, or a metadata line. Truncated to `maxLength`.
 */
export function ticketSnippet(content: string, maxLength = 92): string {
  const effectiveMax = Math.max(4, maxLength);
  const lines = content.split("\n");

  let inSummary = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const lowered = trimmed.toLowerCase();
    if (lowered === "## summary" || lowered === "## description") {
      inSummary = true;
      continue;
    }
    if (inSummary && trimmed.length > 0 && !trimmed.startsWith("#")) {
      return truncateSnippet(trimmed, effectiveMax);
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.length === 0 ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("---") ||
      metadataLine(trimmed)
    ) {
      continue;
    }
    return truncateSnippet(trimmed, effectiveMax);
  }

  return "";
}

/** Case-insensitive substring match on id or content; empty query returns all. */
export function searchTickets(tickets: Ticket[], query: string): Ticket[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return tickets;
  return tickets.filter(
    (ticket) =>
      ticket.id.toLowerCase().includes(needle) ||
      ticket.content.toLowerCase().includes(needle),
  );
}

/** The tone class that colours a status badge or dot. */
export function toneForTicketStatus(status: TicketStatus): string {
  switch (status) {
    case "todo":
      return "tone-info";
    case "in-progress":
      return "tone-waiting";
    case "done":
      return "tone-ok";
  }
}

/** Prepend a new todo ticket, returning the new list and the created ticket. */
export function createTicket(
  tickets: Ticket[],
  draft: { id: string; content: string },
): { tickets: Ticket[]; created: Ticket } {
  const created: Ticket = {
    id: draft.id,
    content: draft.content,
    status: "todo",
    updated: "just now",
  };
  return { tickets: [created, ...tickets], created };
}

/** Set one ticket's content and stamp it "just now"; immutable. */
export function updateTicket(tickets: Ticket[], id: string, content: string): Ticket[] {
  return tickets.map((ticket) =>
    ticket.id === id ? { ...ticket, content, updated: "just now" } : ticket,
  );
}

/** Drop one ticket by id; immutable. */
export function deleteTicket(tickets: Ticket[], id: string): Ticket[] {
  return tickets.filter((ticket) => ticket.id !== id);
}

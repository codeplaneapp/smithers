import { searchTickets, ticketSnippet, toneForTicketStatus, type Ticket } from "./tickets";
import { useTicketsStore } from "./ticketsStore";

function statusLabel(status: Ticket["status"]): string {
  return status === "in-progress" ? "IN PROGRESS" : status.toUpperCase();
}

/** The markdown-editor surface: a ticket list on the left, the editor on the right. */
export function TicketsCanvas() {
  const tickets = useTicketsStore((state) => state.tickets);
  const query = useTicketsStore((state) => state.query);
  const selectedId = useTicketsStore((state) => state.selectedId);
  const draftContent = useTicketsStore((state) => state.draftContent);
  const createOpen = useTicketsStore((state) => state.createOpen);
  const newId = useTicketsStore((state) => state.newId);
  const newContent = useTicketsStore((state) => state.newContent);
  const select = useTicketsStore((state) => state.select);
  const setQuery = useTicketsStore((state) => state.setQuery);
  const setDraft = useTicketsStore((state) => state.setDraft);
  const save = useTicketsStore((state) => state.save);
  const remove = useTicketsStore((state) => state.remove);
  const openCreate = useTicketsStore((state) => state.openCreate);
  const cancelCreate = useTicketsStore((state) => state.cancelCreate);
  const setNewId = useTicketsStore((state) => state.setNewId);
  const setNewContent = useTicketsStore((state) => state.setNewContent);
  const submitCreate = useTicketsStore((state) => state.submitCreate);

  const selected = useTicketsStore(
    (state) => state.tickets.find((t) => t.id === state.selectedId) ?? null,
  );
  const shown = searchTickets(tickets, query);

  return (
    <section className="surface" data-testid="tickets-canvas">
      <header className="surface-head">
        <span className="surface-title">Tickets</span>
        <span className="surface-sub">
          {tickets.length} ticket{tickets.length === 1 ? "" : "s"}
        </span>
        <input
          className="field-input"
          placeholder="Search tickets"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn btn-brand" type="button" onClick={openCreate}>
          New ticket
        </button>
      </header>

      <div className="rev-body">
        <div className="rev-list">
          {createOpen ? (
            <div className="rev-create">
              <div className="rev-create-head">New ticket</div>
              <input
                className="field-input"
                placeholder="ticket-id"
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
              />
              <textarea
                className="field-input"
                placeholder="# Title&#10;&#10;## Summary&#10;…"
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
              />
              <div className="rev-detail-actions">
                <button
                  className="btn btn-brand"
                  type="button"
                  onClick={submitCreate}
                  disabled={newId.trim().length === 0}
                >
                  Create
                </button>
                <button className="btn" type="button" onClick={cancelCreate}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {shown.map((ticket) => (
            <button
              key={ticket.id}
              type="button"
              className={ticket.id === selectedId ? "rev-row is-on" : "rev-row"}
              onClick={() => select(ticket.id)}
              data-testid="tickets-row"
            >
              <span className={`rev-dot ${toneForTicketStatus(ticket.status)}`} />
              <div className="rev-row-main">
                <div className="rev-row-title">{ticket.id}</div>
                <div className="rev-row-meta">
                  <span>{ticketSnippet(ticket.content)}</span>
                  <span className={`state-badge ${toneForTicketStatus(ticket.status)}`}>
                    {statusLabel(ticket.status)}
                  </span>
                </div>
              </div>
            </button>
          ))}
          {shown.length === 0 ? <div className="rev-empty">No tickets match.</div> : null}
        </div>

        <div className="rev-detail">
          {selected ? (
            <div className="rev-detail-scroll">
              <div className="rev-detail-head">
                <span className="rev-detail-title">{selected.id}</span>
                <span className={`state-badge ${toneForTicketStatus(selected.status)}`}>
                  {statusLabel(selected.status)}
                </span>
                <div className="rev-detail-actions">
                  <button
                    className="btn btn-brand"
                    type="button"
                    onClick={save}
                    disabled={draftContent === selected.content}
                  >
                    Save
                  </button>
                  <button className="btn" type="button" onClick={() => remove(selected.id)}>
                    Delete
                  </button>
                </div>
              </div>
              <textarea
                className="rev-editor"
                value={draftContent}
                onChange={(e) => setDraft(e.target.value)}
              />
            </div>
          ) : (
            <div className="rev-detail-empty">Select a ticket to edit.</div>
          )}
        </div>
      </div>
    </section>
  );
}

import { openSurface } from "../app/navigation";
import { ticketSnippet } from "./tickets";
import { useTicketsStore } from "./ticketsStore";

function TicketIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2 2 2 0 0 0 0 4 2 2 0 0 1-2 2H6a2 2 0 0 1-2-2 2 2 0 0 0 0-4ZM12 6v12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The inline tickets card: the first few tickets and a jump to the canvas. */
export function TicketsCard() {
  const tickets = useTicketsStore((state) => state.tickets);
  const shown = tickets.slice(0, 4);

  return (
    <article className="list-card" data-testid="tickets-card">
      <header className="card-head">
        <span className="card-icon">
          <TicketIcon />
        </span>
        <div className="card-headings">
          <div className="card-title">Tickets</div>
          <div className="card-sub">
            {tickets.length} ticket{tickets.length === 1 ? "" : "s"}
          </div>
        </div>
        <button
          className="card-link"
          type="button"
          onClick={() => openSurface({ kind: "tickets" })}
        >
          Open tickets ›
        </button>
      </header>

      <div className="card-body card-body-flush">
        {shown.map((ticket) => (
          <div className="list-row" key={ticket.id}>
            <div className="list-text">
              <div className="list-name vcs-path">{ticket.id}</div>
              <div className="list-meta">{ticketSnippet(ticket.content)}</div>
            </div>
          </div>
        ))}
        {tickets.length > shown.length ? (
          <div className="rev-more">+{tickets.length - shown.length} more</div>
        ) : null}
      </div>
    </article>
  );
}

import { useEffect } from "react";
import { useGatewayMutation, useGatewayTickets } from "@smthrs/gateway-react";
import { gatewayKeys, type GatewayTicketRow } from "@smthrs/gateway-client";
import { useLocalModeRefetch } from "../sync/useLocalModeRefetch";
import { ticketStatusFromWire, ticketUpdatedLabel, type Ticket } from "./tickets";
import { bindTicketActions, useTicketsStore } from "./ticketsStore";

/**
 * Bridge the live `tickets` gateway collection into the tickets store
 * (docs/p1b-plan.md §3.4). The Zustand store can't call React hooks, so this
 * component mounted inside `SmithersCollectionsProvider` in `main.tsx` next to
 * `<CronsBridge/>` / `<MemoryFactsBridge/>` calls `useGatewayTickets()`, maps
 * each `GatewayTicketRow` onto the surface's `Ticket`, and pushes the result into
 * the store on every change. It also installs the
 * `createTicket`/`updateTicket`/`deleteTicket` RPC seam (`bindTicketActions`) so
 * the store's save/delete/create drive the REAL gateway.
 *
 * `listTickets` returns only LIVE docs (soft-deleted tombstones are filtered
 * server-side), so every row here renders. The wire `status` is free-form text;
 * `ticketStatusFromWire` collapses it onto the three-tone `TicketStatus` the
 * badge renders, and `ticketUpdatedLabel` derives the relative "updated" string
 * from `updatedAtMs` (NOT on the wire as a string — presentational, client-side).
 */

/** All kinds (no `kind` filter) so the surface sees every ticket the gateway holds. */
const TICKETS_PARAMS = {} as const;

type CreateTicketVars = { path: string; content: string; status?: string };
type UpdateTicketVars = { path: string; content?: string; status?: string };
type DeleteTicketVars = { path: string };

/**
 * Map a live `GatewayTicketRow` onto the surface's `Ticket`. `path → id` (the
 * stable doc identity, so an open ticket's selection survives a refetch),
 * `status` collapsed to the 3-tone scale, and `updated` derived client-side from
 * `updatedAtMs`.
 */
export function toTicket(row: GatewayTicketRow, now = Date.now()): Ticket {
  return {
    id: row.path,
    content: row.content,
    status: ticketStatusFromWire(row.status),
    updated: ticketUpdatedLabel(row.updatedAtMs, now),
  };
}

export function TicketsBridge() {
  const { data, refetch } = useGatewayTickets(TICKETS_PARAMS);
  const createTicketMutation = useGatewayMutation<CreateTicketVars, unknown>("createTicket", {
    invalidate: [gatewayKeys.tickets(TICKETS_PARAMS)],
  });
  const updateTicketMutation = useGatewayMutation<UpdateTicketVars, unknown>("updateTicket", {
    invalidate: [gatewayKeys.tickets(TICKETS_PARAMS)],
  });
  const deleteTicketMutation = useGatewayMutation<DeleteTicketVars, unknown>("deleteTicket", {
    invalidate: [gatewayKeys.tickets(TICKETS_PARAMS)],
  });

  // Install the real RPC seam so the store's save/delete/create submit live.
  useEffect(() => {
    bindTicketActions({
      create: (vars) => createTicketMutation.mutate(vars),
      update: (vars) => updateTicketMutation.mutate(vars),
      remove: (vars) => deleteTicketMutation.mutate(vars),
      refetch,
    });
  }, [createTicketMutation.mutate, updateTicketMutation.mutate, deleteTicketMutation.mutate, refetch]);

  // LOCAL-MODE freshness: the `tickets` collection is pull-only (no stream), so a
  // doc created/edited anywhere after load — e.g. by an agent, a `.md` file edit
  // the gateway watcher reconciles, or another client — is never pushed here.
  // Poll the small `listTickets` RPC on a modest interval (+ on focus/visibility)
  // so /tickets reflects an out-of-band change within ~LOCAL_LIST_POLL_MS, no
  // reload needed. Local-mode only; the cloud path streams via Electric (P5) and
  // this poll is removed there.
  useLocalModeRefetch(refetch);

  useEffect(() => {
    const tickets = data ? data.map((row) => toTicket(row)) : [];
    useTicketsStore.getState().setTickets(tickets);
  }, [data]);

  return null;
}

import { useCallback } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import type { GatewayTicketRow } from "@smthrs/gateway-client";
import type { ListTicketsRequest } from "@smthrs/gateway-client/rpc";
import { useSmithersCollections } from "./useSmithersCollections.ts";
import { gatewayCollectionAsyncState, type GatewayAsyncState } from "./GatewayAsyncState.ts";

/**
 * Live work docs (tickets/plans/specs/proposals) over the `tickets` collection
 * (initial `listTickets`, re-pulled on `invalidate` — e.g. after a
 * `createTicket` / `updateTicket` / `deleteTicket` mutation). `listTickets`
 * returns only LIVE docs (soft-deleted tombstones are filtered server-side), so
 * every row here is renderable. Pass a `kind` to scope to one doc kind; omit it
 * to list every kind. Same `GatewayAsyncState` shape the other typed gateway
 * hooks return (mirrors `useGatewayCrons` / `useGatewayMemoryFacts`).
 */
export function useGatewayTickets(params: ListTicketsRequest = {}): GatewayAsyncState<GatewayTicketRow[]> {
  const { collections } = useSmithersCollections();
  const collection = collections.tickets(params);
  const live = useLiveQuery((q) => q.from({ row: collection }), [collection]);
  const refetch = useCallback(async () => {
    await collections.invalidate(["tickets"]);
  }, [collections]);

  const data = (live.data ?? []) as GatewayTicketRow[];
  return gatewayCollectionAsyncState({
    collection,
    data,
    hasData: data.length > 0,
    live,
    refetch,
  });
}

import { create } from "zustand";
import { useChatStore } from "../chat/chatStore";
import { useNotificationsStore } from "../notifications/notificationsStore";
import {
  createTicket,
  deleteTicket,
  updateTicket,
  type Ticket,
} from "./tickets";

/**
 * The tickets store: the LIVE ticket list (pushed in by `TicketsBridge` from the
 * gateway `tickets` collection — the `listTickets` RPC over `_smithers_docs`),
 * plus the editor's selection, search, draft buffer, and create form.
 *
 * There is NO in-app seed: the gateway is the source of truth. Mutations drive
 * the REAL gateway RPCs via the `rpc` seam (`bindTicketActions`, mirroring
 * `bindCronActions`): save → `updateTicket`, delete → `deleteTicket`, create →
 * `createTicket`. Each action updates the list OPTIMISTICALLY, then the bridge
 * re-pulls `listTickets` so the canonical server rows reconcile. Feedback (a chat
 * line + a transient toast) is posted the same way the crons/vcs stores do.
 */

/**
 * The shape `TicketsBridge` installs so store actions can hit the gateway RPCs.
 * `create`/`update`/`remove` resolve on success and reject on RPC failure; the
 * store rolls the optimistic list back and posts a failure toast on a reject.
 * `refetch` re-pulls the live `tickets` collection.
 */
type TicketRpc = {
  /** `createTicket` — create or replace a work doc by `path` (id). */
  create: (vars: { path: string; content: string; status?: string }) => Promise<unknown>;
  /** `updateTicket` — patch a work doc's content (and/or status) by `path`. */
  update: (vars: { path: string; content?: string; status?: string }) => Promise<unknown>;
  /** `deleteTicket` — soft-delete a work doc by `path`. */
  remove: (vars: { path: string }) => Promise<unknown>;
  /** Re-pull the live `tickets` collection after a mutation lands. */
  refetch: () => Promise<unknown> | void;
};

type TicketsState = {
  tickets: Ticket[];
  selectedId: string | null;
  query: string;
  /** The editor buffer for the selected ticket. */
  draftContent: string;
  createOpen: boolean;
  newId: string;
  newContent: string;
  /** The live gateway RPC seam, installed by `TicketsBridge` (null pre-mount). */
  rpc: TicketRpc | null;
  /** Push the live ticket list in (called by the bridge) and reconcile selection. */
  setTickets: (tickets: Ticket[]) => void;
  select: (id: string) => void;
  setQuery: (value: string) => void;
  setDraft: (value: string) => void;
  save: () => void;
  remove: (id: string) => void;
  openCreate: () => void;
  cancelCreate: () => void;
  setNewId: (value: string) => void;
  setNewContent: (value: string) => void;
  submitCreate: () => void;
};

export const useTicketsStore = create<TicketsState>((set, get) => ({
  tickets: [],
  selectedId: null,
  query: "",
  draftContent: "",
  createOpen: false,
  newId: "",
  newContent: "",
  rpc: null,

  setTickets: (tickets) => {
    set((state) => {
      // Keep the selection across reconciles; fall back to the first row when the
      // selected ticket vanished (e.g. it was soft-deleted out-of-band).
      let selectedId: string | null = null;
      let draftContent = state.draftContent;
      const stillThere = state.selectedId && tickets.some((t) => t.id === state.selectedId);
      if (stillThere) {
        selectedId = state.selectedId;
        // Only refresh the draft when the user has no unsaved edits in flight,
        // so a background refetch never clobbers what they are typing.
        const live = tickets.find((t) => t.id === selectedId);
        const prior = state.tickets.find((t) => t.id === selectedId);
        if (live && prior && state.draftContent === prior.content) {
          draftContent = live.content;
        }
      } else {
        const fallback = tickets[0] ?? null;
        selectedId = fallback ? fallback.id : null;
        draftContent = fallback ? fallback.content : "";
      }
      return { tickets, selectedId, draftContent };
    });
  },

  select: (id) => {
    const ticket = get().tickets.find((t) => t.id === id);
    set({ selectedId: id, draftContent: ticket ? ticket.content : "" });
  },

  setQuery: (value) => set({ query: value }),

  setDraft: (value) => set({ draftContent: value }),

  save: () => {
    const { selectedId, draftContent, tickets, rpc } = get();
    if (!selectedId || !rpc) return;
    const prior = tickets.find((t) => t.id === selectedId);
    if (!prior) return;

    // Optimistic content update; the refetch reconciles the canonical server row.
    set({ tickets: updateTicket(tickets, selectedId, draftContent) });

    void rpc
      .update({ path: selectedId, content: draftContent })
      .then(() => rpc.refetch())
      .then(() => {
        useChatStore.getState().say(`Saved ticket \`${selectedId}\`.`);
        useNotificationsStore.getState().notify({
          title: "Ticket saved",
          detail: selectedId,
          kind: "transient",
          command: "chat",
        });
      })
      .catch((error: unknown) => {
        // Roll the optimistic edit back and recover canonical state.
        set((state) => ({
          tickets: updateTicket(state.tickets, selectedId, prior.content),
        }));
        useNotificationsStore.getState().notify({
          title: "Could not save ticket",
          detail: `${selectedId}: ${errorText(error)}`,
          kind: "transient",
          command: "chat",
        });
        void rpc.refetch();
      });
  },

  remove: (id) => {
    const { tickets, selectedId, rpc } = get();
    if (!rpc) return;
    const target = tickets.find((t) => t.id === id);
    if (!target) return;

    // Optimistic removal; the refetch reconciles after `deleteTicket` lands.
    const next = deleteTicket(tickets, id);
    const patch: Partial<TicketsState> = { tickets: next };
    if (selectedId === id) {
      const fallback = next[0] ?? null;
      patch.selectedId = fallback ? fallback.id : null;
      patch.draftContent = fallback ? fallback.content : "";
    }
    set(patch);

    void rpc
      .remove({ path: id })
      .then(() => rpc.refetch())
      .then(() => {
        useChatStore.getState().say(`Deleted ticket \`${id}\`.`);
        useNotificationsStore.getState().notify({
          title: "Ticket deleted",
          detail: id,
          kind: "transient",
          command: "chat",
        });
      })
      .catch((error: unknown) => {
        // Restore the row on failure and recover canonical state.
        set((state) => ({
          tickets: [target, ...state.tickets.filter((t) => t.id !== target.id)],
        }));
        useNotificationsStore.getState().notify({
          title: "Could not delete ticket",
          detail: `${id}: ${errorText(error)}`,
          kind: "transient",
          command: "chat",
        });
        void rpc.refetch();
      });
  },

  openCreate: () => set({ createOpen: true, newId: "", newContent: "" }),

  cancelCreate: () => set({ createOpen: false }),

  setNewId: (value) => set({ newId: value }),

  setNewContent: (value) => set({ newContent: value }),

  submitCreate: () => {
    const { newId, newContent, tickets, rpc } = get();
    const id = newId.trim();
    if (id.length === 0 || !rpc) return;

    // Optimistic prepend + close the form; the refetch reconciles the canonical
    // server row (status/updated) once `createTicket` lands.
    const { tickets: next, created } = createTicket(tickets, { id, content: newContent });
    set({
      tickets: next,
      selectedId: created.id,
      draftContent: created.content,
      createOpen: false,
      newId: "",
      newContent: "",
    });

    void rpc
      // A new ticket is created `todo` (the surface's default tone).
      .create({ path: created.id, content: created.content, status: "todo" })
      .then(() => rpc.refetch())
      .then(() => {
        useChatStore.getState().say(`Created ticket \`${created.id}\`.`);
        useNotificationsStore.getState().notify({
          title: "Ticket created",
          detail: created.id,
          kind: "transient",
          command: "chat",
        });
      })
      .catch((error: unknown) => {
        // Roll the optimistic row back and recover canonical state.
        set((state) => ({
          tickets: state.tickets.filter((t) => t.id !== created.id),
          selectedId: state.selectedId === created.id ? null : state.selectedId,
        }));
        useNotificationsStore.getState().notify({
          title: "Could not create ticket",
          detail: `${created.id}: ${errorText(error)}`,
          kind: "transient",
          command: "chat",
        });
        void rpc.refetch();
      });
  },
}));

/** Best-effort human text for an RPC failure surfaced in a toast. */
function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  if (typeof error === "string" && error.trim() !== "") return error;
  return "the gateway rejected the request";
}

/**
 * Install the live gateway RPC seam into the store. Called by `TicketsBridge`
 * (the only place that may hold the `createTicket`/`updateTicket`/`deleteTicket`
 * mutations + the collection refetch). Keeps React hooks out of the Zustand store
 * body while the store's save/delete/create still drive the REAL gateway RPCs.
 */
export function bindTicketActions(rpc: TicketRpc): void {
  useTicketsStore.setState({ rpc });
}

import type { Effect } from "effect";
import type { SmithersError } from "@smithers-orchestrator/errors";
import type { MemoryNamespace } from "../MemoryNamespace";
import type { MemoryFact } from "../MemoryFact";
import type { MemoryThread } from "../MemoryThread";
import type { MemoryMessage } from "../MemoryMessage";
import type { MemoryNote, SaveNoteInput, NoteReadFilter } from "../MemoryNote";
import type { MemoryProvenance } from "../MemoryProvenance";

export type MemoryStore = {
  getFact: (
    ns: MemoryNamespace,
    key: string,
  ) => Promise<MemoryFact | undefined>;
  setFact: (
    ns: MemoryNamespace,
    key: string,
    value: unknown,
    ttlMs?: number,
    provenance?: MemoryProvenance,
  ) => Promise<void>;
  deleteFact: (ns: MemoryNamespace, key: string) => Promise<void>;
  listFacts: (ns: MemoryNamespace) => Promise<MemoryFact[]>;
  listAllFacts: () => Promise<MemoryFact[]>;
  createThread: (ns: MemoryNamespace, title?: string) => Promise<MemoryThread>;
  getThread: (threadId: string) => Promise<MemoryThread | undefined>;
  listThreads: () => Promise<MemoryThread[]>;
  deleteThread: (threadId: string) => Promise<void>;
  saveMessage: (
    msg: Omit<MemoryMessage, "createdAtMs"> & { createdAtMs?: number },
  ) => Promise<void>;
  listMessages: (threadId: string, limit?: number) => Promise<MemoryMessage[]>;
  countMessages: (threadId: string) => Promise<number>;
  deleteMessages: (threadId: string, messageIds: string[]) => Promise<number>;
  deleteExpiredFacts: () => Promise<number>;
  saveNote: (input: SaveNoteInput) => Promise<MemoryNote>;
  getNote: (id: string) => Promise<MemoryNote | undefined>;
  listNotes: (
    ns: MemoryNamespace,
    filter?: NoteReadFilter,
  ) => Promise<MemoryNote[]>;
  setNoteStatus: (id: string, status: string) => Promise<void>;
  enableNoteSearch: (kind: string) => Promise<void>;
  searchNotes: (
    kind: string,
    query: string,
    limit?: number,
    filter?: NoteReadFilter,
  ) => Promise<MemoryNote[]>;
  getFactEffect: (
    ns: MemoryNamespace,
    key: string,
  ) => Effect.Effect<MemoryFact | undefined, SmithersError>;
  setFactEffect: (
    ns: MemoryNamespace,
    key: string,
    value: unknown,
    ttlMs?: number,
    provenance?: MemoryProvenance,
  ) => Effect.Effect<void, SmithersError>;
  deleteFactEffect: (
    ns: MemoryNamespace,
    key: string,
  ) => Effect.Effect<void, SmithersError>;
  listFactsEffect: (
    ns: MemoryNamespace,
  ) => Effect.Effect<MemoryFact[], SmithersError>;
  listAllFactsEffect: () => Effect.Effect<MemoryFact[], SmithersError>;
  createThreadEffect: (
    ns: MemoryNamespace,
    title?: string,
  ) => Effect.Effect<MemoryThread, SmithersError>;
  getThreadEffect: (
    threadId: string,
  ) => Effect.Effect<MemoryThread | undefined, SmithersError>;
  listThreadsEffect: () => Effect.Effect<MemoryThread[], SmithersError>;
  deleteThreadEffect: (
    threadId: string,
  ) => Effect.Effect<void, SmithersError>;
  saveMessageEffect: (
    msg: Omit<MemoryMessage, "createdAtMs"> & { createdAtMs?: number },
  ) => Effect.Effect<void, SmithersError>;
  listMessagesEffect: (
    threadId: string,
    limit?: number,
  ) => Effect.Effect<MemoryMessage[], SmithersError>;
  countMessagesEffect: (
    threadId: string,
  ) => Effect.Effect<number, SmithersError>;
  deleteMessagesEffect: (
    threadId: string,
    messageIds: string[],
  ) => Effect.Effect<number, SmithersError>;
  deleteExpiredFactsEffect: () => Effect.Effect<number, SmithersError>;
  saveNoteEffect: (
    input: SaveNoteInput,
  ) => Effect.Effect<MemoryNote, SmithersError>;
  getNoteEffect: (
    id: string,
  ) => Effect.Effect<MemoryNote | undefined, SmithersError>;
  listNotesEffect: (
    ns: MemoryNamespace,
    filter?: NoteReadFilter,
  ) => Effect.Effect<MemoryNote[], SmithersError>;
  setNoteStatusEffect: (
    id: string,
    status: string,
  ) => Effect.Effect<void, SmithersError>;
  enableNoteSearchEffect: (
    kind: string,
  ) => Effect.Effect<void, SmithersError>;
  searchNotesEffect: (
    kind: string,
    query: string,
    limit?: number,
    filter?: NoteReadFilter,
  ) => Effect.Effect<MemoryNote[], SmithersError>;
};

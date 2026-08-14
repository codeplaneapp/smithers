import type { Effect } from "effect";
import type { SmithersError } from "@smthrs/errors";
import type { MemoryNamespace } from "./MemoryNamespace";
import type { MemoryFact } from "./MemoryFact";
import type { MemoryNote } from "./MemoryNote";
import type { SaveNoteInput } from "./SaveNoteInput";
import type { NoteReadFilter } from "./NoteReadFilter";
import type { MemoryProvenance } from "./MemoryProvenance";
import type { MemoryThread } from "./MemoryThread";
import type { MemoryMessage } from "./MemoryMessage";
import type { MemoryStore } from "./store/MemoryStore";

export type MemoryServiceApi = {
  readonly getFact: (ns: MemoryNamespace, key: string) => Effect.Effect<MemoryFact | undefined, SmithersError>;
  readonly setFact: (
    ns: MemoryNamespace,
    key: string,
    value: unknown,
    ttlMs?: number,
    provenance?: MemoryProvenance,
  ) => Effect.Effect<void, SmithersError>;
  readonly deleteFact: (ns: MemoryNamespace, key: string) => Effect.Effect<void, SmithersError>;
  readonly listFacts: (ns: MemoryNamespace) => Effect.Effect<MemoryFact[], SmithersError>;
  readonly createThread: (ns: MemoryNamespace, title?: string) => Effect.Effect<MemoryThread, SmithersError>;
  readonly getThread: (threadId: string) => Effect.Effect<MemoryThread | undefined, SmithersError>;
  readonly deleteThread: (threadId: string) => Effect.Effect<void, SmithersError>;
  readonly saveMessage: (
    msg: Omit<MemoryMessage, "createdAtMs"> & { createdAtMs?: number },
  ) => Effect.Effect<void, SmithersError>;
  readonly listMessages: (threadId: string, limit?: number) => Effect.Effect<MemoryMessage[], SmithersError>;
  readonly countMessages: (threadId: string) => Effect.Effect<number, SmithersError>;
  readonly deleteExpiredFacts: () => Effect.Effect<number, SmithersError>;
  readonly saveNote: (input: SaveNoteInput) => Effect.Effect<MemoryNote, SmithersError>;
  readonly getNote: (id: string) => Effect.Effect<MemoryNote | undefined, SmithersError>;
  readonly listNotes: (ns: MemoryNamespace, filter?: NoteReadFilter) => Effect.Effect<MemoryNote[], SmithersError>;
  readonly setNoteStatus: (id: string, status: string) => Effect.Effect<void, SmithersError>;
  readonly enableNoteSearch: (kind: string) => Effect.Effect<void, SmithersError>;
  readonly searchNotes: (
    kind: string,
    query: string,
    limit?: number,
    filter?: NoteReadFilter,
  ) => Effect.Effect<MemoryNote[], SmithersError>;
  readonly store: MemoryStore;
};

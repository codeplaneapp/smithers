import { Effect } from "effect";
import type { SmithersError } from "@smithers/core/errors";
import type { MemoryStore } from "./store/MemoryStore";

export type MemoryProcessor = {
  name: string;
  process: (store: MemoryStore) => Promise<void>;
  processEffect: (store: MemoryStore) => Effect.Effect<void, SmithersError>;
};

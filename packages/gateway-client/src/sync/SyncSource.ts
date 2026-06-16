import type { CollectionConfig } from "@tanstack/db";
import type { CollectionDef } from "./CollectionDef.ts";
import type { ConnectionObserver } from "./ConnectionObserver.ts";

export type SyncSource = {
  collection<TRow extends object, TKey extends string | number>(
    def: CollectionDef<TRow, TKey>,
  ): CollectionConfig<TRow, TKey>;
  status(): ConnectionObserver;
  reset?(): void;
};

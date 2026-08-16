import type { MemoryProps } from "./MemoryProps.ts";
import type { TrellisProps } from "./delegation-v2/TrellisProps.ts";

export type MemoryTrellisProps = TrellisProps & {
  /** Shared bounded memory policy inherited by every generated Trellis task. */
  memory: Omit<MemoryProps, "children">;
};

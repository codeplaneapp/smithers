import type { AnyEventObject } from "xstate";

/** One machine event collected from a durable row, positioned in the fold's total order. */
export type FoldEvent = {
  /** Shared provenance clock position of the source row (outputs and signals). */
  seq: number;
  /** Index of the producing source in the `events` declaration array. */
  declarationIndex: number;
  /** Index within the array a single `map` call returned (0 for scalar returns). */
  subIndex: number;
  /** The mapped machine event. */
  event: AnyEventObject;
};

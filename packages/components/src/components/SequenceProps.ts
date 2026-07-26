import type React from "react";

export type SequenceProps = {
  key?: string;
  /** Display name for this group in run views (graph, /workflows mirror). */
  label?: string;
  failurePolicy?: "halt" | "quarantine";
  skipIf?: boolean;
  children?: React.ReactNode;
};

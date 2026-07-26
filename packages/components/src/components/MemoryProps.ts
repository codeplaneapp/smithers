import type React from "react";

export type MemoryProps = {
  /** One memory bank. Mutually exclusive with `banks`. */
  bank?: string;
  /** Memory banks recalled in parallel. Mutually exclusive with `bank`. */
  banks?: string[];
  /** Stable recall and retention dimensions such as branch, stream, source, and scope. */
  tags?: string[];
  /** Recall query mode. `auto` derives the query from each task prompt. Defaults to `auto`. */
  recall?: "auto" | string | false;
  /** Hindsight candidate-search budget. Defaults to `mid`. */
  budget?: "low" | "mid" | "high";
  /** Maximum tokens injected across recalled memories and primers. Defaults to 2048. */
  maxTokens?: number;
  /** Mental-model ids whose saved content is injected verbatim. */
  primers?: string[];
  /** Retain a successful task result asynchronously. Defaults to `off`. */
  retain?: "on-complete" | "off";
  /** Expose `remember` and `recall` tools to descendant task agents. Defaults to false. */
  tools?: boolean;
  /** Workflow content that inherits this memory configuration. */
  children?: React.ReactNode;
};

import type React from "react";
import type { z } from "zod";

/**
 * Props for the generic GitHub listener. Compiles to the existing
 * `smithers:wait-for-event` intrinsic: event name
 * `integration:github:<event>[.<action>]`, correlationId
 * `<repo>#<number>` | `<repo>` | none.
 */
export type OnWebhookProps<Schema extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> = {
  id: string;
  /** GitHub webhook event name, e.g. `pull_request`, `issues`, `push`. */
  event: string;
  /** Optional action filter, e.g. `opened` — waits on the per-action signal. */
  action?: string;
  /** `owner/repo` correlation filter. */
  repo?: string;
  /** Entity number filter (requires `repo`). */
  number?: number;
  /** Zod schema for the payload (loose/passthrough). */
  schema?: Schema;
  timeoutMs?: number;
  onTimeout?: "fail" | "skip" | "continue";
  /** Do not block unrelated downstream flow while waiting. */
  async?: boolean;
  skipIf?: boolean;
  dependsOn?: string[];
  needs?: Record<string, string>;
  label?: string;
  meta?: Record<string, unknown>;
  key?: string;
  children?: (payload: z.infer<Schema>) => React.ReactNode;
  smithersContext?: React.Context<any>;
};

/** Sugar-listener props: everything generic except `event`/`action`/`schema`. */
export type GitHubSugarListenerProps<Schema extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> = Omit<
  OnWebhookProps<Schema>,
  "event"
>;

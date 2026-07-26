import type React from "react";
import type { z } from "zod";

/** Props shared by the Telegram listener components. */
export type TelegramListenerBaseProps<Schema extends z.ZodTypeAny> = {
  /** Node id (also the output lookup key for render-prop children). */
  id: string;
  /** Only wake for this chat (correlationId `chat:<chatId>`). Omit to match any-correlation waits. */
  chatId?: number | string;
  /** Only wake for this forum-topic thread (correlationId `chat:<chatId>:thread:<threadId>`; requires chatId). */
  threadId?: number | string;
  /** Zod schema override for the delivered payload. */
  schema?: Schema;
  timeoutMs?: number;
  onTimeout?: "fail" | "skip" | "continue";
  /** Do not block unrelated downstream flow while waiting. */
  async?: boolean;
  skipIf?: boolean;
  dependsOn?: string[];
  label?: string;
  meta?: Record<string, unknown>;
  key?: string;
  children?: (data: z.infer<Schema>) => React.ReactNode;
  smithersContext?: React.Context<unknown>;
};

export type OnMessageProps<Schema extends z.ZodTypeAny> = TelegramListenerBaseProps<Schema> & {
  /** Listen for edits instead of new messages. */
  edited?: boolean;
};

export type OnCallbackQueryProps<Schema extends z.ZodTypeAny> = TelegramListenerBaseProps<Schema>;

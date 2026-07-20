import type React from "react";
import type { z } from "zod";
import type {
  SendMessageSmartOptions,
  TelegramClientConfig,
  TelegramDocumentInput,
  TelegramInlineKeyboard,
} from "../TelegramClientTypes.ts";

/** Loose deps spec (mirrors Task's DepsSpec: dep key → zod output schema). */
export type TelegramDepsSpec = Record<string, z.ZodTypeAny>;

type ResolvedDeps = Record<string, unknown>;

/** Props shared by every outbound Telegram compute-Task component. */
export type TelegramOutboundBaseProps = {
  id: string;
  /** Explicit client config; falls back to configureTelegram()/env. */
  config?: Partial<TelegramClientConfig>;
  /**
   * Upstream outputs to consume. The component resolves them itself and
   * renders a compute Task gated on them via `dependsOn` (Task's own
   * deps+function-children path would evaluate at render time as a static
   * payload — see Task.js — so it is deliberately not used here).
   */
  deps?: TelegramDepsSpec;
  /** dep key → node id when they differ. */
  needs?: Record<string, string>;
  output?: z.ZodTypeAny;
  outputSchema?: z.ZodTypeAny;
  retryPolicy?: unknown;
  timeoutMs?: number;
  dependsOn?: string[];
  async?: boolean;
  skipIf?: boolean;
  label?: string;
  key?: string;
  smithersContext?: React.Context<unknown>;
};

export type SendMessageProps = TelegramOutboundBaseProps & {
  chatId: number | string;
  /** Static message text (standard markdown). */
  text?: string;
  /**
   * Build the message from resolved deps: return the text, or an object of
   * `{ text, ...SendMessageSmartOptions }` overrides.
   */
  children?: (
    deps: ResolvedDeps,
  ) => string | ({ text: string } & SendMessageSmartOptions);
  parseMode?: SendMessageSmartOptions["parseMode"];
  replyToMessageId?: number;
  messageThreadId?: number;
  inlineKeyboard?: TelegramInlineKeyboard;
  /** Show the typing indicator before sending. @default true */
  typing?: boolean;
  disableNotification?: boolean;
};

export type EditMessageProps = TelegramOutboundBaseProps & {
  chatId: number | string;
  messageId?: number;
  text?: string;
  children?: (
    deps: ResolvedDeps,
  ) => string | { text: string; messageId?: number; inlineKeyboard?: TelegramInlineKeyboard };
  parseMode?: SendMessageSmartOptions["parseMode"];
  inlineKeyboard?: TelegramInlineKeyboard;
};

export type SendDocumentProps = TelegramOutboundBaseProps & {
  chatId: number | string;
  document?: TelegramDocumentInput;
  caption?: string;
  replyToMessageId?: number;
  messageThreadId?: number;
  children?: (
    deps: ResolvedDeps,
  ) => { document: TelegramDocumentInput; caption?: string };
};

export type AnswerCallbackQueryProps = TelegramOutboundBaseProps & {
  callbackQueryId?: string;
  text?: string;
  showAlert?: boolean;
  children?: (
    deps: ResolvedDeps,
  ) => { callbackQueryId: string; text?: string; showAlert?: boolean };
};

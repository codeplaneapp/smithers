import { AnswerCallbackQueryProps as AnswerCallbackQueryProps$1, EditMessageProps as EditMessageProps$1, SendDocumentProps as SendDocumentProps$1, SendMessageProps as SendMessageProps$1 } from './outboundProps.js';
import * as React from 'react';
import { z } from 'zod';
import '../TelegramClientTypes.js';
import 'effect';
import '@smithers-orchestrator/errors/SmithersError';

/**
 * Send a Telegram message as a durable compute Task: chunks at 4096 chars on
 * paragraph/sentence boundaries, converts markdown → MarkdownV2 with
 * plain-text fallback on parse errors, shows a typing indicator, threads
 * replies (`replyToMessageId`, `messageThreadId`), and attaches an inline
 * keyboard to the last chunk. Text comes from the `text` prop or is built
 * from resolved `deps` by the function children.
 *
 * @param {SendMessageProps} props
 */
declare function SendMessage(props: SendMessageProps): React.ReactElement<any, string | React.JSXElementConstructor<any>> | null;
/**
 * Edit a previously sent message in place (MarkdownV2 with plain-text
 * fallback), as a durable compute Task.
 * @param {EditMessageProps} props
 */
declare function EditMessage(props: EditMessageProps): React.ReactElement<any, string | React.JSXElementConstructor<any>> | null;
/**
 * Send a document (URL/file_id via JSON, raw content via multipart upload)
 * as a durable compute Task.
 * @param {SendDocumentProps} props
 */
declare function SendDocument(props: SendDocumentProps): React.ReactElement<any, string | React.JSXElementConstructor<any>> | null;
/**
 * Answer an inline-keyboard callback query (dismisses the client-side
 * loading state; optionally shows a toast/alert), as a durable compute Task.
 * Pairs with `<OnCallbackQuery>`.
 * @param {AnswerCallbackQueryProps} props
 */
declare function AnswerCallbackQuery(props: AnswerCallbackQueryProps): React.ReactElement<any, string | React.JSXElementConstructor<any>> | null;
/** Output shape produced by `<SendMessage>` (sendMessageSmart's result). */
declare const TelegramSendResultSchema: z.ZodObject<{
    chatId: z.ZodString;
    messageIds: z.ZodArray<z.ZodNumber>;
    chunkCount: z.ZodNumber;
    usedPlainTextFallback: z.ZodBoolean;
}, z.core.$strip>;
type SendMessageProps = SendMessageProps$1;
type EditMessageProps = EditMessageProps$1;
type SendDocumentProps = SendDocumentProps$1;
type AnswerCallbackQueryProps = AnswerCallbackQueryProps$1;

export { AnswerCallbackQuery, type AnswerCallbackQueryProps, EditMessage, type EditMessageProps, SendDocument, type SendDocumentProps, SendMessage, type SendMessageProps, TelegramSendResultSchema };

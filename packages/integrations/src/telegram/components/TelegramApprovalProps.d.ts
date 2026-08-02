import React__default from 'react';
import { z } from 'zod';
import { TelegramClientConfig, SendMessageSmartOptions } from '../TelegramClientTypes.js';
import { TelegramApprovalMode, TelegramApprovalOption } from '../approvalTypes.js';
import 'effect';
import '@smthrs/errors/SmithersError';

/** The request rendered into the approval prompt. */
type TelegramApprovalRequest = {
    /** Short title / question, e.g. "Deploy to prod?". */
    title: string;
    /** Optional detail shown under the title (standard markdown). */
    summary?: string;
};
type TelegramApprovalProps = {
    /** Node id. The decision output is stored under this id. */
    id: string;
    /** Chat that receives the prompt and whose button press resolves it. */
    chatId: number | string;
    /** Forum-topic thread to scope the prompt + wait to (isolates concurrent approvals). */
    threadId?: number | string;
    /** What is being approved. */
    request: TelegramApprovalRequest;
    /** Where to store the decision (a createSmithers output target). */
    output?: z.ZodTypeAny;
    /** Override the decision output schema. Defaults to the approve/select schema. */
    outputSchema?: z.ZodTypeAny;
    /** "approve" (Approve/Reject) or "select" (one button per option). @default "approve" */
    mode?: TelegramApprovalMode;
    /** Options for `mode: "select"`. */
    options?: TelegramApprovalOption[];
    /** Approve-button label (approve mode). */
    approveText?: string;
    /** Reject-button label (approve mode). */
    rejectText?: string;
    /** Add a Mini App (`web_app`) button opening this HTTPS url for a richer UI. */
    miniApp?: {
        url: string;
        text?: string;
    };
    /** Telegram client config; falls back to configureTelegram()/env. */
    config?: Partial<TelegramClientConfig>;
    /** Prompt/outcome message format. @default "markdown" */
    parseMode?: SendMessageSmartOptions["parseMode"];
    /** Max wait for the button press before timing out. */
    timeoutMs?: number;
    onTimeout?: "fail" | "skip" | "continue";
    /** Do not block unrelated downstream flow while waiting. */
    async?: boolean;
    skipIf?: boolean;
    dependsOn?: string[];
    key?: string;
    smithersContext?: React__default.Context<unknown>;
};

export type { TelegramApprovalProps, TelegramApprovalRequest };

import * as zod from 'zod';
import { TelegramListenerBaseProps } from './OnMessageProps.js';
import React__default from 'react';

/**
 * Derive the correlationId for a listener's chat/thread props.
 * @param {{ chatId?: number | string; threadId?: number | string }} props
 * @returns {string | undefined}
 */
declare function listenerCorrelationId(props: {
    chatId?: number | string;
    threadId?: number | string;
}): string | undefined;
/**
 * @param {string} eventName integration signal name to wait for
 * @param {import("./OnMessageProps.ts").TelegramListenerBaseProps<any>} props
 * @param {import("zod").ZodTypeAny} schema effective payload schema
 * @returns {React.ReactElement | null}
 */
declare function renderTelegramListener(eventName: string, props: TelegramListenerBaseProps<any>, schema: zod.ZodTypeAny): React__default.ReactElement | null;

export { listenerCorrelationId, renderTelegramListener };

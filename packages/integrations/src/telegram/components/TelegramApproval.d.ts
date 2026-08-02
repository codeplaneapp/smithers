import { TelegramApprovalProps as TelegramApprovalProps$1, TelegramApprovalRequest as TelegramApprovalRequest$1 } from './TelegramApprovalProps.js';
import React__default from 'react';
import { TelegramSendResultSchema } from './SendMessage.js';
import { TelegramCallbackQuerySchema } from '../schemas.js';
import 'zod';
import '../TelegramClientTypes.js';
import 'effect';
import '@smthrs/errors/SmithersError';
import '../approvalTypes.js';
import './outboundProps.js';

/**
 * Durable Telegram approval. See the file header for the composition.
 * @param {TelegramApprovalProps} props
 * @returns {React.ReactElement | null}
 */
declare function TelegramApproval(props: TelegramApprovalProps): React__default.ReactElement | null;
declare namespace telegramApprovalSchemas {
    export { TelegramSendResultSchema as telegramApprovalPrompt };
    export { TelegramCallbackQuerySchema as telegramApprovalCallback };
}
type TelegramApprovalProps = TelegramApprovalProps$1;
type TelegramApprovalRequest = TelegramApprovalRequest$1;

export { TelegramApproval, type TelegramApprovalProps, type TelegramApprovalRequest, telegramApprovalSchemas };

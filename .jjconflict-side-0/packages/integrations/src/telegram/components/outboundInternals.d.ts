import { TelegramClientService } from '../TelegramClientTypes.js';
import { TelegramDepsSpec, TelegramOutboundBaseProps } from './outboundProps.js';
import { Effect } from 'effect';
import React__default from 'react';
import '@smithers-orchestrator/errors/SmithersError';
import 'zod';

/**
 * @param {import("./outboundProps.ts").TelegramDepsSpec | undefined} deps
 * @param {Record<string, string> | undefined} needs
 * @returns {string[]}
 */
declare function depNodeIds(deps: TelegramDepsSpec | undefined, needs: Record<string, string> | undefined): string[];
/**
 * Resolve a deps spec against the workflow ctx (mirror of Task's internal
 * resolveDeps). Returns null while any dep is missing.
 * @param {any} ctx
 * @param {import("./outboundProps.ts").TelegramDepsSpec | undefined} deps
 * @param {Record<string, string> | undefined} needs
 * @returns {Record<string, unknown> | null}
 */
declare function resolveOutboundDeps(ctx: any, deps: TelegramDepsSpec | undefined, needs: Record<string, string> | undefined): Record<string, unknown> | null;
/**
 * Render an outbound Telegram compute Task.
 * @param {import("./outboundProps.ts").TelegramOutboundBaseProps} props
 * @param {string} componentName
 * @param {(client: import("../TelegramClientTypes.ts").TelegramClientService, resolvedDeps: Record<string, unknown>) => Effect.Effect<unknown, unknown>} run
 * @returns {React.ReactElement | null}
 */
declare function renderOutboundTask(props: TelegramOutboundBaseProps, componentName: string, run: (client: TelegramClientService, resolvedDeps: Record<string, unknown>) => Effect.Effect<unknown, unknown>): React__default.ReactElement | null;

export { depNodeIds, renderOutboundTask, resolveOutboundDeps };

import { IncomingMessage, ServerResponse } from "node:http";
import { Effect } from "effect";
export type ServerOptions = {
    port?: number;
    db?: unknown;
    authToken?: string;
    maxBodyBytes?: number;
    rootDir?: string;
    allowNetwork?: boolean;
};
export declare function startServerEffect(opts?: ServerOptions): Effect.Effect<import("node:http").Server<typeof IncomingMessage, typeof ServerResponse>, never, never>;
export declare function startServer(opts?: ServerOptions): import("node:http").Server<typeof IncomingMessage, typeof ServerResponse>;

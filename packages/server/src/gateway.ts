import { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { SmithersWorkflow } from "@smithers/components/SmithersWorkflow";
export type RequestFrame = {
    type: "req";
    id: string;
    method: string;
    params?: unknown;
};
export type ResponseFrame = {
    type: "res";
    id: string;
    ok: boolean;
    payload?: unknown;
    error?: {
        code: string;
        message: string;
    };
};
export type EventFrame = {
    type: "event";
    event: string;
    payload?: unknown;
    seq: number;
    stateVersion: number;
};
export type ConnectRequest = {
    minProtocol: number;
    maxProtocol: number;
    client: {
        id: string;
        version: string;
        platform: string;
    };
    auth?: {
        token: string;
    } | {
        password: string;
    };
    subscribe?: string[];
};
export type HelloResponse = {
    protocol: number;
    features: string[];
    policy: {
        heartbeatMs: number;
    };
    auth: {
        sessionToken: string;
        role: string;
        scopes: string[];
        userId: string | null;
    };
    snapshot: {
        runs: any[];
        approvals: any[];
        stateVersion: number;
    };
};
export type GatewayTokenGrant = {
    role: string;
    scopes: string[];
    userId?: string;
};
export type GatewayAuthConfig = {
    mode: "token";
    tokens: Record<string, GatewayTokenGrant>;
} | {
    mode: "jwt";
    issuer: string;
    audience: string | string[];
    secret: string;
    scopesClaim?: string;
    roleClaim?: string;
    userClaim?: string;
    defaultRole?: string;
    defaultScopes?: string[];
    clockSkewSeconds?: number;
} | {
    mode: "trusted-proxy";
    trustedHeaders?: string[];
    allowedOrigins?: string[];
    defaultRole?: string;
    defaultScopes?: string[];
};
export type GatewayDefaults = {
    cliAgentTools?: "all" | "explicit-only";
};
export type GatewayOptions = {
    protocol?: number;
    features?: string[];
    heartbeatMs?: number;
    auth?: GatewayAuthConfig;
    defaults?: GatewayDefaults;
    maxBodyBytes?: number;
    maxPayload?: number;
    maxConnections?: number;
};
type GatewayWebhookSignalConfig = {
    name: string;
    correlationIdPath?: string;
    runIdPath?: string;
    payloadPath?: string;
};
type GatewayWebhookRunConfig = {
    enabled?: boolean;
    inputPath?: string;
};
type GatewayWebhookConfig = {
    secret: string;
    signatureHeader?: string;
    signaturePrefix?: string;
    signal?: GatewayWebhookSignalConfig;
    run?: GatewayWebhookRunConfig;
};
export declare const GATEWAY_RPC_MAX_PAYLOAD_BYTES = 1048576;
export declare const GATEWAY_RPC_MAX_DEPTH = 32;
export declare const GATEWAY_RPC_MAX_ARRAY_LENGTH = 256;
export declare const GATEWAY_RPC_MAX_STRING_LENGTH: number;
export declare const GATEWAY_METHOD_NAME_MAX_LENGTH = 64;
export declare const GATEWAY_FRAME_ID_MAX_LENGTH = 128;
export declare const GATEWAY_RPC_INPUT_MAX_BYTES = 1048576;
export declare const GATEWAY_RPC_INPUT_MAX_DEPTH = 32;
export declare function validateGatewayMethodName(method: unknown): string;
export declare function parseGatewayRequestFrame(raw: unknown, maxPayloadBytes?: number): RequestFrame;
export declare function getGatewayInputDepth(value: unknown): number;
export declare function assertGatewayInputDepthWithinBounds(value: unknown, maxDepth?: number): number;
export declare class Gateway {
    readonly protocol: number;
    readonly features: string[];
    readonly heartbeatMs: number;
    readonly maxBodyBytes: number;
    readonly maxPayload: number;
    readonly maxConnections: number;
    readonly auth?: GatewayAuthConfig;
    readonly defaults?: GatewayDefaults;
    private readonly workflows;
    private readonly connections;
    private readonly runRegistry;
    private readonly activeRuns;
    private readonly inflightRuns;
    private server;
    private wsServer;
    private schedulerTimer;
    private stateVersion;
    private readonly startedAtMs;
    constructor(options?: GatewayOptions);
    private authModeLabel;
    private recordMessageReceived;
    private recordMessageSent;
    private recordAuthEvent;
    private executeRpc;
    private rpcSuccessEffect;
    private sendHttpRpcResponse;
    private runWaitsForSignal;
    private findMatchingWebhookRuns;
    private handleWebhook;
    register(key: string, workflow: SmithersWorkflow<any>, options?: {
        schedule?: string;
        webhook?: GatewayWebhookConfig;
    }): this;
    listen(options?: {
        port?: number;
    }): Promise<Server<typeof IncomingMessage, typeof ServerResponse>>;
    close(): Promise<void>;
    private startScheduler;
    private syncRegisteredSchedules;
    private processDueCrons;
    private startRun;
    private resumeRunIfNeeded;
    private handleSocket;
    private startHeartbeat;
    private handleConnect;
    private authenticate;
    private authenticateRequest;
    private handleHttpRpc;
    private sendResponse;
    private sendEvent;
    private broadcastEvent;
    private buildSnapshot;
    private adapterForWorkflow;
    private listRunsAcrossWorkflows;
    private listPendingApprovals;
    private listCrons;
    private findCron;
    private resolveRun;
    private handleSmithersEvent;
    private mapEvent;
    private routeRequest;
}
export {};

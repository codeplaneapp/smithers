/// <reference path="../types/bun-test-shim.d.ts" />
type RuntimeConformanceResult = {
    result: {
        runId: string;
        status: string;
        output?: unknown;
    };
    stored: {
        status?: string;
    } | undefined;
    outputs: Record<string, unknown[]> | undefined;
    generateCalls: number;
    schemaEnforced: boolean;
    capabilityProof: Record<string, {
        runtime: string;
        capability: string;
        operation: string;
    }>;
    host: Record<string, unknown>;
};
type RuntimeConformanceLane = "Browser" | "Cloudflare Workers" | "Vercel" | "Node.js" | "Bun";
/** Assert the portable production workflow contract for every supported host. */
declare function assertRuntimeConformance(proof: RuntimeConformanceResult, lane: RuntimeConformanceLane): RuntimeConformanceResult;
declare function isRuntimeCapabilityError(error: unknown, capability: string, operation: string): boolean;

export { type RuntimeConformanceLane, type RuntimeConformanceResult, assertRuntimeConformance, isRuntimeCapabilityError };

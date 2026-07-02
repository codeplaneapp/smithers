import type { AgentAvailabilityStatus } from "./AgentAvailabilityStatus.ts";

export type AgentAvailability = {
    id: "claude" | "codex" | "antigravity" | "pi" | "opencode" | "openclaw" | "kimi" | "amp" | "vibe" | "hermes";
    displayName: string;
    binary: string;
    deprecated?: boolean;
    deprecationReason?: string;
    hasBinary: boolean;
    hasAuthSignal: boolean;
    hasApiKeySignal: boolean;
    hasProjectTrustSignal: boolean;
    status: AgentAvailabilityStatus;
    score: number;
    usable: boolean;
    checks: string[];
    unusableReasons: string[];
};

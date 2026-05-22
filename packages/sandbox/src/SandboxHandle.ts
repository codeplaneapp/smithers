import type { SandboxRuntime } from "./SandboxRuntime.ts";

export type SandboxPortMapping = {
    host: number;
    container: number;
};

export type SandboxVolumeMount = {
    host: string;
    container: string;
    readonly?: boolean;
};

export type SandboxWorkspaceSpec = {
    name: string;
    snapshotId?: string;
    idleTimeoutSecs?: number;
    persistence?: "ephemeral" | "sticky";
};

export type SandboxHandle = {
    runtime: SandboxRuntime;
    runId: string;
    sandboxId: string;
    sandboxRoot: string;
    requestPath: string;
    resultPath: string;
    image?: string;
    allowNetwork?: boolean;
    env?: Record<string, string>;
    ports?: SandboxPortMapping[];
    volumes?: SandboxVolumeMount[];
    memoryLimit?: string;
    cpuLimit?: string;
    workspace?: SandboxWorkspaceSpec;
    containerId?: string;
    workspaceId?: string;
};

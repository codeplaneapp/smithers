import type { SandboxRuntime } from "./SandboxRuntime.ts";
import type { SandboxPortMapping, SandboxVolumeMount, SandboxWorkspaceSpec } from "./SandboxHandle.ts";

export type SandboxTransportConfig = {
    runId: string;
    sandboxId: string;
    runtime: SandboxRuntime;
    rootDir: string;
    image?: string;
    allowNetwork?: boolean;
    env?: Record<string, string>;
    ports?: SandboxPortMapping[];
    volumes?: SandboxVolumeMount[];
    memoryLimit?: string;
    cpuLimit?: string;
    workspace?: SandboxWorkspaceSpec;
};

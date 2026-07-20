import type { SandboxRuntime } from "./SandboxRuntime.ts";
import type { SandboxPortMapping, SandboxVolumeMount, SandboxWorkspaceSpec } from "./SandboxHandle.ts";
import type { SandboxEgressConfig } from "./SandboxEgressConfig.ts";

export type SandboxTransportConfig = {
    runId: string;
    sandboxId: string;
    runtime: SandboxRuntime;
    rootDir: string;
    image?: string;
    allowNetwork?: boolean;
    env?: Record<string, string>;
    egress?: SandboxEgressConfig;
    ports?: SandboxPortMapping[];
    volumes?: SandboxVolumeMount[];
    memoryLimit?: string;
    cpuLimit?: string;
    workspace?: SandboxWorkspaceSpec;
};

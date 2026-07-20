// @smithers-type-exports-begin
/** @typedef {import("./SandboxRuntime.ts").SandboxRuntime} SandboxRuntime */
/** @typedef {import("./SandboxEgressConfig.ts").SandboxEgressConfig} SandboxEgressConfig */
/** @typedef {import("./SandboxVolumeMount.ts").SandboxVolumeMount} SandboxVolumeMount */
/** @typedef {import("./SandboxWorkspaceSpec.ts").SandboxWorkspaceSpec} SandboxWorkspaceSpec */
// @smithers-type-exports-end

import React from "react";
/** @typedef {import("./SandboxProps.ts").SandboxProps} SandboxProps */

/**
 * @param {SandboxProps} props
 */
export function Sandbox(props) {
    if (props.skipIf)
        return null;
    return React.createElement("smithers:sandbox", {
        id: props.id,
        key: props.key,
        output: props.output,
        provider: props.provider,
        runtime: props.runtime,
        allowNetwork: props.allowNetwork,
        reviewDiffs: props.reviewDiffs,
        autoAcceptDiffs: props.autoAcceptDiffs,
        allowNested: props.allowNested,
        image: props.image,
        env: props.env,
        egress: props.egress,
        ports: props.ports,
        volumes: props.volumes,
        memoryLimit: props.memoryLimit,
        cpuLimit: props.cpuLimit,
        command: props.command,
        workspace: props.workspace,
        timeoutMs: props.timeoutMs,
        heartbeatTimeoutMs: props.heartbeatTimeoutMs,
        heartbeatTimeout: props.heartbeatTimeout,
        retries: props.retries,
        retryPolicy: props.retryPolicy,
        continueOnFail: props.continueOnFail,
        cache: props.cache,
        dependsOn: props.dependsOn,
        needs: props.needs,
        label: props.label ?? props.id,
        meta: props.meta,
        __smithersSandboxProvider: props.provider,
        __smithersSandboxWorkflow: props.workflow,
        __smithersSandboxInput: props.input,
        __smithersSandboxRuntime: props.runtime,
        __smithersSandboxAllowNested: props.allowNested,
        __smithersSandboxChildren: props.children,
    });
}

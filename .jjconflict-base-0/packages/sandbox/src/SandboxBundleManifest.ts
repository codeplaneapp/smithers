import type { SandboxDiffBundleLike } from "./SandboxProvider.ts";

export type SandboxBundleManifest = {
	outputs: unknown;
	status: "finished" | "failed" | "cancelled";
	runId?: string;
	patches?: string[];
	diffBundle?: SandboxDiffBundleLike;
};

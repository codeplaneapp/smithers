import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { SANDBOX_PROVIDER_RESULT_ENV } from "./SANDBOX_PROVIDER_RESULT_ENV.js";

/**
 * Parse the raw result JSON a sandbox runner produced (from stdout or the
 * result file) into a SandboxProviderResult, filling remote id fields from the
 * session's remoteId when the runner did not supply them.
 *
 * @param {string} raw
 * @param {string} remoteId
 * @param {{ provider?: string; resultPath?: string }} [context]
 * @returns {import("../SandboxProvider.ts").SandboxProviderResult & Record<string, unknown>}
 */
export function parseSandboxProviderResult(raw, remoteId, context = {}) {
	const trimmed = String(raw ?? "").trim();
	if (trimmed === "") {
		throw new SmithersError(
			"SANDBOX_EXECUTION_FAILED",
			`Sandbox produced no result JSON: the runner must write result JSON to ${context.resultPath ?? "the result path"} (via ${SANDBOX_PROVIDER_RESULT_ENV}) or print it to stdout.`,
			{ provider: context.provider, remoteId },
		);
	}
	let parsed;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		throw new SmithersError(
			"SANDBOX_EXECUTION_FAILED",
			`Sandbox produced invalid result JSON: ${error instanceof Error ? error.message : String(error)}. Raw output: ${trimmed.slice(0, 500)}`,
			{ provider: context.provider, remoteId },
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new SmithersError(
			"SANDBOX_EXECUTION_FAILED",
			"Sandbox result JSON must be an object.",
			{ provider: context.provider, remoteId },
		);
	}
	if ("bundlePath" in parsed && "status" in parsed) {
		throw new SmithersError(
			"SANDBOX_EXECUTION_FAILED",
			"Sandbox result JSON contains both bundlePath and status, which are mutually exclusive: bundlePath is a diff-bundle passthrough result and status is an inline result. The runner must return exactly one shape.",
			{ provider: context.provider, remoteId },
		);
	}
	return {
		...parsed,
		remoteRunId: parsed.remoteRunId ?? parsed.runId ?? remoteId,
		workspaceId: parsed.workspaceId ?? remoteId,
		containerId: parsed.containerId ?? remoteId,
	};
}

import { redactSandboxEgressConfig } from "../egress.js";

/**
 * Serialize the sandbox request payload the in-sandbox runner reads. Egress is
 * redacted so no raw proxy secrets or CA material land in the request file.
 *
 * @param {import("./SandboxSession.ts").SandboxSession} session
 * @param {string} requestPath
 * @param {import("../SandboxProvider.ts").SandboxProviderRequest} request
 * @returns {Promise<Record<string, unknown>>}
 */
export async function writeSandboxProviderRequestFile(session, requestPath, request) {
	const payload = {
		runId: request.runId,
		sandboxId: request.sandboxId,
		input: request.input,
		config: request.config,
		allowNetwork: request.allowNetwork,
		maxOutputBytes: request.maxOutputBytes,
		egress: request.egress === undefined ? undefined : redactSandboxEgressConfig(request.egress),
	};
	await session.writeFile(requestPath, JSON.stringify(payload));
	return payload;
}

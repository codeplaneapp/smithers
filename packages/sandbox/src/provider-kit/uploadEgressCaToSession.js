import { SANDBOX_EGRESS_CA_BUNDLE_RELATIVE_PATH } from "../egress.js";

/**
 * Materialize an inline egress CA bundle into the sandbox session's workdir so
 * the runner's HTTPS clients can trust the egress proxy. Returns the written
 * path, or null when the egress config carries no inline PEM.
 *
 * @param {import("./SandboxSession.ts").SandboxSession} session
 * @param {import("../SandboxEgressConfig.ts").SandboxEgressConfig | undefined} egress
 * @param {string} workdir
 * @returns {Promise<string | null>}
 */
export async function uploadEgressCaToSession(session, egress, workdir) {
	const caCertPem = egress?.caCertPem;
	if (typeof caCertPem !== "string" || caCertPem.length === 0) {
		return null;
	}
	const caPath = absolutePath(workdir, SANDBOX_EGRESS_CA_BUNDLE_RELATIVE_PATH);
	await session.writeFile(caPath, caCertPem);
	return caPath;
}

/**
 * @param {string} workdir
 * @param {string} path
 * @returns {string}
 */
function absolutePath(workdir, path) {
	return path.startsWith("/") ? path : `${workdir.replace(/\/+$/g, "")}/${path.replace(/^\/+/g, "")}`;
}

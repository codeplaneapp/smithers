import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { AWS_SANDBOX_PROVIDER_ID } from "./AWS_SANDBOX_PROVIDER_ID.js";

/**
 * Resolve an AWS SDK v3 client into a flat method-based surface the runners and
 * transport call.
 *
 * - When `injected` already implements every method in `methods` (a test double
 *   or higher-level wrapper) it is returned untouched and the real SDK is NEVER
 *   imported — this is what lets CI run with zero AWS credentials and without
 *   the optional `@aws-sdk/*` packages installed.
 * - Otherwise the module is lazily imported; a real client is constructed (or an
 *   injected raw `.send()` client is reused) and each method is wrapped to
 *   `client.send(new <Method>Command(input))`.
 *
 * @param {{
 *   injected?: unknown;
 *   moduleName: string;
 *   clientExport: string;
 *   methods: string[];
 *   clientOptions?: Record<string, unknown>;
 * }} config
 * @returns {Promise<Record<string, (input: Record<string, unknown>) => Promise<any>>>}
 */
export async function resolveAwsSdkClient(config) {
	const { injected, moduleName, clientExport, methods, clientOptions } = config;
	if (injected && methods.every((method) => typeof (/** @type {Record<string, unknown>} */ (injected))[method] === "function")) {
		return /** @type {Record<string, (input: Record<string, unknown>) => Promise<any>>} */ (injected);
	}
	let mod;
	try {
		mod = /** @type {Record<string, any>} */ (await import(/* @vite-ignore */ moduleName));
	} catch (error) {
		throw new SmithersError(
			"INVALID_INPUT",
			`The AWS sandbox provider needs "${moduleName}". Install it with \`npm install ${moduleName}\` (it is an optional dependency): ${error instanceof Error ? error.message : String(error)}`,
			{ provider: AWS_SANDBOX_PROVIDER_ID, module: moduleName },
		);
	}
	const Client = mod[clientExport];
	if (typeof Client !== "function") {
		throw new SmithersError(
			"INVALID_INPUT",
			`"${moduleName}" does not export ${clientExport}.`,
			{ provider: AWS_SANDBOX_PROVIDER_ID, module: moduleName },
		);
	}
	const client = injected ?? new Client({ ...(clientOptions ?? {}) });
	/** @type {Record<string, (input: Record<string, unknown>) => Promise<any>>} */
	const surface = {};
	for (const method of methods) {
		const commandExport = `${method.charAt(0).toUpperCase()}${method.slice(1)}Command`;
		const Command = mod[commandExport];
		if (typeof Command !== "function") {
			throw new SmithersError(
				"INVALID_INPUT",
				`"${moduleName}" does not export ${commandExport}.`,
				{ provider: AWS_SANDBOX_PROVIDER_ID, module: moduleName },
			);
		}
		surface[method] = (input) => /** @type {{ send: (command: unknown) => Promise<any> }} */ (client).send(new Command(input));
	}
	return surface;
}

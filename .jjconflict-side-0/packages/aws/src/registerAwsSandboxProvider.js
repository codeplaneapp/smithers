import { registerSandboxProvider } from "@smithers-orchestrator/sandbox";
import { createAwsSandboxProvider } from "./createAwsSandboxProvider.js";

/**
 * Construct an AWS sandbox provider and register it with the sandbox runtime.
 *
 * @param {import("./AwsSandboxProviderOptions.ts").AwsSandboxProviderOptions} [options]
 * @returns {() => void} unregister function
 */
export function registerAwsSandboxProvider(options = {}) {
	return registerSandboxProvider(createAwsSandboxProvider(options));
}

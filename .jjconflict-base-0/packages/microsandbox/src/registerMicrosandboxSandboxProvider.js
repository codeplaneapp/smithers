import { registerSandboxProvider } from "@smithers-orchestrator/sandbox";
import { createMicrosandboxSandboxProvider } from "./createMicrosandboxSandboxProvider.js";

/**
 * Build and register a Microsandbox provider in Smithers' global registry.
 *
 * @param {import("./MicrosandboxSandboxProviderOptions.ts").MicrosandboxSandboxProviderOptions} [options]
 * @returns {() => void}
 */
export function registerMicrosandboxSandboxProvider(options = {}) {
	return registerSandboxProvider(createMicrosandboxSandboxProvider(options));
}

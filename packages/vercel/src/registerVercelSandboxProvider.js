import { registerSandboxProvider } from "@smithers-orchestrator/sandbox";
import { createVercelSandboxProvider } from "./createVercelSandboxProvider.js";

/**
 * Construct a Vercel sandbox provider and register it with the sandbox runtime.
 *
 * @param {import("./VercelSandboxProviderOptions.ts").VercelSandboxProviderOptions} [options]
 * @returns {() => void} unregister function
 */
export function registerVercelSandboxProvider(options = {}) {
  return registerSandboxProvider(createVercelSandboxProvider(options));
}

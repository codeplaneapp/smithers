import { registerSandboxProvider } from "@smthrs/sandbox";
import { createGcpSandboxProvider } from "./createGcpSandboxProvider.js";

/**
 * Construct a GCP sandbox provider and register it in the global sandbox
 * provider registry. Returns the unregister function.
 *
 * @param {import("./GcpSandboxProviderOptions.ts").GcpSandboxProviderOptions} [options]
 * @returns {() => void}
 */
export function registerGcpSandboxProvider(options = {}) {
  return registerSandboxProvider(createGcpSandboxProvider(options));
}

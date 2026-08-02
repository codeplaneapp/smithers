import { registerSandboxProvider } from "@smthrs/sandbox";
import { createDaytonaSandboxProvider } from "./createDaytonaSandboxProvider.js";

/**
 * Construct a Daytona sandbox provider and register it in the global provider
 * registry. Returns the unregister function.
 *
 * @param {import("./DaytonaSandboxProviderOptions.ts").DaytonaSandboxProviderOptions} [options]
 * @returns {() => void}
 */
export function registerDaytonaSandboxProvider(options = {}) {
  return registerSandboxProvider(createDaytonaSandboxProvider(options));
}

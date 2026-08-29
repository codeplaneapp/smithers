import { createSandboxProviderContractSuite } from "@smthrs/sandbox";
import { MICROSANDBOX_PROVIDER_ID } from "../src/MICROSANDBOX_PROVIDER_ID.js";
import { createMicrosandboxSandboxProvider } from "../src/createMicrosandboxSandboxProvider.js";
import { createMockMicrosandboxEnvironment } from "./fixtures/createMockMicrosandboxEnvironment.js";

createSandboxProviderContractSuite({
  name: "Microsandbox SandboxProvider contract",
  expectedProviderId: MICROSANDBOX_PROVIDER_ID,
  createProvider(handler, providerOptions = {}) {
    const { onDestroy, ...rest } = providerOptions;
    return createMicrosandboxSandboxProvider({
      sdk: createMockMicrosandboxEnvironment(handler, { onStop: onDestroy }),
      ...rest,
    });
  },
});

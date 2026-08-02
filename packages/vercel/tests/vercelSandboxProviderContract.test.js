import { createSandboxProviderContractSuite } from "@smthrs/sandbox";
import { VERCEL_SANDBOX_PROVIDER_ID } from "../src/VERCEL_SANDBOX_PROVIDER_ID.js";
import { createVercelSandboxProvider } from "../src/createVercelSandboxProvider.js";
import { createMockVercelSandboxEnvironment } from "../src/createMockVercelSandboxEnvironment.js";

createSandboxProviderContractSuite({
  name: "vercel sandbox provider",
  expectedProviderId: VERCEL_SANDBOX_PROVIDER_ID,
  createProvider: (handler, providerOptions = {}) => {
    const { onDestroy, cleanup, ...rest } = providerOptions;
    return createVercelSandboxProvider({
      client: createMockVercelSandboxEnvironment(handler, { onDestroy }),
      oidcToken: "test-oidc-token",
      cleanup,
      ...rest,
    });
  },
});

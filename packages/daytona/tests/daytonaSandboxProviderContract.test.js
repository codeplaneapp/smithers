import { createSandboxProviderContractSuite } from "@smithers-orchestrator/sandbox";
import { DAYTONA_SANDBOX_PROVIDER_ID } from "../src/DAYTONA_SANDBOX_PROVIDER_ID.js";
import { createDaytonaSandboxProvider } from "../src/createDaytonaSandboxProvider.js";
import { createMockDaytonaSandboxEnvironment } from "../src/createMockDaytonaSandboxEnvironment.js";

createSandboxProviderContractSuite({
  name: "daytona sandbox provider",
  expectedProviderId: DAYTONA_SANDBOX_PROVIDER_ID,
  createProvider: (handler, providerOptions = {}) => {
    const { onDestroy, ...rest } = providerOptions;
    return createDaytonaSandboxProvider({
      client: createMockDaytonaSandboxEnvironment(handler, { onDestroy }),
      ...rest,
    });
  },
});

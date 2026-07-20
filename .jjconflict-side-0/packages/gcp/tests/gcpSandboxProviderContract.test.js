import { createSandboxProviderContractSuite } from "@smithers-orchestrator/sandbox";
import { GCP_SANDBOX_PROVIDER_ID } from "../src/GCP_SANDBOX_PROVIDER_ID.js";
import { createGcpSandboxProvider } from "../src/createGcpSandboxProvider.js";
import { createMockGcpSandboxEnvironment } from "../src/createMockGcpSandboxEnvironment.js";

createSandboxProviderContractSuite({
	name: "createGcpSandboxProvider (Cloud Run Jobs, mock)",
	expectedProviderId: GCP_SANDBOX_PROVIDER_ID,
	createProvider: (handler, providerOptions = {}) =>
		createGcpSandboxProvider({
			client: createMockGcpSandboxEnvironment(handler),
			projectId: "contract-project",
			location: "us-central1",
			bucket: "contract-bucket",
			jobName: "contract-job",
			...providerOptions,
		}),
});

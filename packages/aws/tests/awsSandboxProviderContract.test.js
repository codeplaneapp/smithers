import { createSandboxProviderContractSuite } from "@smithers-orchestrator/sandbox";
import { AWS_SANDBOX_PROVIDER_ID, createAwsSandboxProvider, createMockAwsSandboxEnvironment } from "../src/index.js";

const FARGATE_OPTS = {
	region: "us-east-1",
	bucket: "smithers-sandbox-test",
	cluster: "smithers",
	taskDefinition: "smithers-sandbox:1",
	subnets: ["subnet-abc123"],
	containerName: "runner",
};

const CODEBUILD_OPTS = {
	mode: "codebuild",
	region: "us-east-1",
	bucket: "smithers-sandbox-test",
	projectName: "smithers-sandbox",
};

/**
 * @param {Record<string, unknown>} requiredOpts
 */
function makeCreateProvider(requiredOpts) {
	/**
	 * @param {(args: { command: string; request: Record<string, unknown>; files: Map<string, string>; env: Record<string, string> }) => any} handler
	 * @param {Record<string, any>} [providerOptions]
	 */
	return (handler, providerOptions = {}) => {
		const { onDestroy, ...rest } = providerOptions;
		const env = createMockAwsSandboxEnvironment(handler);
		if (typeof onDestroy === "function") {
			const stopTask = env.ecs.stopTask;
			env.ecs.stopTask = async (input) => {
				onDestroy();
				return stopTask(input);
			};
			const stopBuild = env.codebuild.stopBuild;
			env.codebuild.stopBuild = async (input) => {
				onDestroy();
				return stopBuild(input);
			};
		}
		return createAwsSandboxProvider({ clients: env, ...requiredOpts, ...rest });
	};
}

createSandboxProviderContractSuite({
	name: "aws fargate sandbox provider contract",
	expectedProviderId: AWS_SANDBOX_PROVIDER_ID,
	createProvider: makeCreateProvider(FARGATE_OPTS),
});

createSandboxProviderContractSuite({
	name: "aws codebuild sandbox provider contract",
	expectedProviderId: AWS_SANDBOX_PROVIDER_ID,
	createProvider: makeCreateProvider(CODEBUILD_OPTS),
});

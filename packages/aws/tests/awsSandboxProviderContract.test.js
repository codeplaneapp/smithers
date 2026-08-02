import { createSandboxProviderContractSuite } from "@smthrs/sandbox";
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
      // A destroy always tears down transient S3 objects (both modes), so hook
      // deleteObjects as the reliable "destroy happened" signal. StopTask can be
      // legitimately skipped when a fargate task already reached STOPPED on its
      // own, so it is not a dependable destroy marker.
      const deleteObjects = env.s3.deleteObjects;
      env.s3.deleteObjects = async (input) => {
        onDestroy();
        return deleteObjects(input);
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

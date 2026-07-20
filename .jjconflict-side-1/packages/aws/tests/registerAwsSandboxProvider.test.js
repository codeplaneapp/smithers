import { describe, expect, test } from "bun:test";
import { AWS_SANDBOX_PROVIDER_ID, createMockAwsSandboxEnvironment, registerAwsSandboxProvider } from "../src/index.js";

const FARGATE_OPTS = {
	region: "us-east-1",
	bucket: "smithers-sandbox-test",
	cluster: "smithers",
	taskDefinition: "smithers-sandbox:1",
	subnets: ["subnet-abc123"],
	containerName: "runner",
};

describe("registerAwsSandboxProvider", () => {
	test("registers the AWS provider and returns an unregister function", () => {
		const clients = createMockAwsSandboxEnvironment(() => ({ status: "finished" }));
		const unregister = registerAwsSandboxProvider({ clients, id: `${AWS_SANDBOX_PROVIDER_ID}-reg-test`, ...FARGATE_OPTS });
		expect(typeof unregister).toBe("function");
		// Idempotent teardown must not throw.
		expect(() => unregister()).not.toThrow();
	});
});

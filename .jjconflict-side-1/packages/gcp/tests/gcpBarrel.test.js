import { describe, expect, test } from "bun:test";
import { resolveSandboxProvider } from "@smithers-orchestrator/sandbox";
import * as barrel from "../src/index.js";
import { registerGcpSandboxProvider } from "../src/registerGcpSandboxProvider.js";
import { createMockGcpSandboxEnvironment } from "../src/createMockGcpSandboxEnvironment.js";

const REQUIRED = { projectId: "p", location: "us-central1", bucket: "b", jobName: "j" };

describe("gcp package barrel", () => {
	test("re-exports the public surface", () => {
		expect(barrel.GCP_SANDBOX_PROVIDER_ID).toBe("gcp-sandbox");
		expect(typeof barrel.createGcpSandboxProvider).toBe("function");
		expect(typeof barrel.registerGcpSandboxProvider).toBe("function");
		expect(typeof barrel.createMockGcpSandboxEnvironment).toBe("function");
		expect(typeof barrel.createGcpSandboxGcsTransport).toBe("function");
		expect(typeof barrel.createGcpCloudRunJobsSandboxRunner).toBe("function");
	});
});

describe("registerGcpSandboxProvider", () => {
	test("registers the provider in the global registry and returns an unregister fn", () => {
		const env = createMockGcpSandboxEnvironment(() => ({ status: "finished" }));
		const unregister = registerGcpSandboxProvider({ ...REQUIRED, id: "gcp-register-test", client: env });
		expect(resolveSandboxProvider("gcp-register-test").id).toBe("gcp-register-test");
		expect(typeof unregister).toBe("function");
		unregister();
		expect(() => resolveSandboxProvider("gcp-register-test")).toThrow(/not registered/);
	});
});

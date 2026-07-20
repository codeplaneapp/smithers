import { describe, expect, test } from "bun:test";
import * as sandbox from "../src/index.js";

describe("sandbox package barrel", () => {
	test("re-exports the bundle surface", () => {
		expect(typeof sandbox.validateSandboxBundle).toBe("function");
		expect(typeof sandbox.writeSandboxBundle).toBe("function");
		expect(sandbox.SANDBOX_MAX_BUNDLE_BYTES).toBe(100 * 1024 * 1024);
		expect(sandbox.SANDBOX_MAX_README_BYTES).toBe(5 * 1024 * 1024);
		expect(sandbox.SANDBOX_MAX_PATCH_FILES).toBe(1000);
	});

	test("re-exports the egress surface", () => {
		expect(typeof sandbox.normalizeSandboxEgressConfig).toBe("function");
		expect(typeof sandbox.sandboxEgressEnv).toBe("function");
		expect(typeof sandbox.writeSandboxEgressFiles).toBe("function");
		expect(typeof sandbox.redactSandboxEgressConfig).toBe("function");
		expect(sandbox.SANDBOX_EGRESS_CA_BUNDLE_RELATIVE_PATH).toBe(".smithers/egress/ca.crt");
	});

	test("re-exports the execute surface", () => {
		expect(typeof sandbox.executeSandbox).toBe("function");
		expect(typeof sandbox.registerSandboxProvider).toBe("function");
		expect(typeof sandbox.resolveSandboxProvider).toBe("function");
	});

	test("re-exports the transport surface", () => {
		expect(typeof sandbox.SandboxTransport).toBe("function");
		expect(typeof sandbox.makeSandboxTransportLayer).toBe("function");
		expect(typeof sandbox.layerForSandboxRuntime).toBe("function");
		expect(typeof sandbox.resolveSandboxRuntime).toBe("function");
	});

	test("re-exports the provider kit", () => {
		expect(typeof sandbox.createCommandSandboxProvider).toBe("function");
		expect(typeof sandbox.createSandboxProviderContractSuite).toBe("function");
		expect(typeof sandbox.parseSandboxProviderResult).toBe("function");
		expect(typeof sandbox.writeSandboxProviderRequestFile).toBe("function");
		expect(typeof sandbox.redactSandboxProviderValue).toBe("function");
		expect(typeof sandbox.uploadEgressCaToSession).toBe("function");
		expect(sandbox.SANDBOX_PROVIDER_REQUEST_ENV).toBe("SMITHERS_SANDBOX_REQUEST_PATH");
		expect(sandbox.SANDBOX_PROVIDER_RESULT_ENV).toBe("SMITHERS_SANDBOX_RESULT_PATH");
	});
});

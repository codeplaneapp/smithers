import { describe, expect, test } from "bun:test";
import { resolveSandboxProvider } from "@smithers-orchestrator/sandbox";
import { MICROSANDBOX_PROVIDER_ID } from "../src/MICROSANDBOX_PROVIDER_ID.js";
import { createMockMicrosandboxEnvironment } from "../src/createMockMicrosandboxEnvironment.js";
import { registerMicrosandboxSandboxProvider } from "../src/registerMicrosandboxSandboxProvider.js";

describe("registerMicrosandboxSandboxProvider", () => {
	test("registers the default id and returns an unregister function", () => {
		const unregister = registerMicrosandboxSandboxProvider({
			sdk: createMockMicrosandboxEnvironment(() => ({ status: "finished" })),
		});
		expect(resolveSandboxProvider(MICROSANDBOX_PROVIDER_ID)?.id).toBe(MICROSANDBOX_PROVIDER_ID);
		unregister();
		expect(() => resolveSandboxProvider(MICROSANDBOX_PROVIDER_ID)).toThrow(/not registered/);
	});

	test("registers a custom id", () => {
		const unregister = registerMicrosandboxSandboxProvider({
			id: "microvm-local",
			sdk: createMockMicrosandboxEnvironment(() => ({ status: "finished" })),
		});
		expect(resolveSandboxProvider("microvm-local")?.id).toBe("microvm-local");
		unregister();
	});
});

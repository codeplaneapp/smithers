import { describe, expect, test } from "bun:test";
import * as index from "../src/index.js";
import { VERCEL_SANDBOX_PROVIDER_ID } from "../src/VERCEL_SANDBOX_PROVIDER_ID.js";
import { createMockVercelSandboxEnvironment } from "../src/createMockVercelSandboxEnvironment.js";
import { registerVercelSandboxProvider } from "../src/registerVercelSandboxProvider.js";

describe("package index barrel", () => {
	test("re-exports the public surface", () => {
		expect(index.VERCEL_SANDBOX_PROVIDER_ID).toBe(VERCEL_SANDBOX_PROVIDER_ID);
		expect(typeof index.createVercelSandboxProvider).toBe("function");
		expect(typeof index.registerVercelSandboxProvider).toBe("function");
		expect(typeof index.createMockVercelSandboxEnvironment).toBe("function");
	});
});

describe("registerVercelSandboxProvider", () => {
	test("registers a Vercel provider and returns a working unregister function", () => {
		const client = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
		const unregister = registerVercelSandboxProvider({ id: "vercel-register-test", client, oidcToken: "t" });
		expect(typeof unregister).toBe("function");
		// Unregistering must not throw and is safe to call.
		expect(() => unregister()).not.toThrow();
	});
});

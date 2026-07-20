import { describe, expect, test } from "bun:test";
import { resolveSandboxProvider } from "@smithers-orchestrator/sandbox";
import { DAYTONA_SANDBOX_PROVIDER_ID } from "../src/DAYTONA_SANDBOX_PROVIDER_ID.js";
import { createMockDaytonaSandboxEnvironment } from "../src/createMockDaytonaSandboxEnvironment.js";
import { registerDaytonaSandboxProvider } from "../src/registerDaytonaSandboxProvider.js";

describe("registerDaytonaSandboxProvider", () => {
	test("registers a resolvable provider and returns an unregister function", () => {
		const id = "daytona-register-test";
		const unregister = registerDaytonaSandboxProvider({
			id,
			client: createMockDaytonaSandboxEnvironment(() => ({ status: "finished" })),
		});
		expect(typeof unregister).toBe("function");
		const resolved = resolveSandboxProvider(id);
		expect(resolved?.id).toBe(id);
		expect(typeof resolved?.run).toBe("function");
		unregister();
		expect(() => resolveSandboxProvider(id)).toThrow(/not registered/);
	});

	test("defaults to the Daytona provider id", () => {
		const unregister = registerDaytonaSandboxProvider({
			client: createMockDaytonaSandboxEnvironment(() => ({ status: "finished" })),
		});
		const resolved = resolveSandboxProvider(DAYTONA_SANDBOX_PROVIDER_ID);
		expect(resolved?.id).toBe(DAYTONA_SANDBOX_PROVIDER_ID);
		unregister();
	});
});

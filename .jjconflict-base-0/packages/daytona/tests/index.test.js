import { describe, expect, test } from "bun:test";
import {
	createDaytonaSandboxProvider,
	createMockDaytonaSandboxEnvironment,
	DAYTONA_SANDBOX_PROVIDER_ID,
	registerDaytonaSandboxProvider,
} from "../src/index.js";

describe("package barrel exports", () => {
	test("re-exports the public surface", () => {
		expect(DAYTONA_SANDBOX_PROVIDER_ID).toBe("daytona-sandbox");
		expect(typeof createDaytonaSandboxProvider).toBe("function");
		expect(typeof createMockDaytonaSandboxEnvironment).toBe("function");
		expect(typeof registerDaytonaSandboxProvider).toBe("function");
	});
});

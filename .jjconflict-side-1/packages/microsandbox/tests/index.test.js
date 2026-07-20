import { describe, expect, test } from "bun:test";
import {
	MICROSANDBOX_PROVIDER_ID,
	createMicrosandboxSandboxProvider,
	registerMicrosandboxSandboxProvider,
} from "../src/index.js";

describe("microsandbox package barrel", () => {
	test("exports the first-class provider surface", () => {
		expect(MICROSANDBOX_PROVIDER_ID).toBe("microsandbox");
		expect(typeof createMicrosandboxSandboxProvider).toBe("function");
		expect(typeof registerMicrosandboxSandboxProvider).toBe("function");
	});
});

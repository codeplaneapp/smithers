import { describe, expect, test } from "bun:test";
import { createGcpSandboxGcsTransport } from "../src/createGcpSandboxGcsTransport.js";
import { createMockGcpSandboxEnvironment } from "../src/createMockGcpSandboxEnvironment.js";

function makeTransport(overrides = {}) {
	const env = createMockGcpSandboxEnvironment(() => ({ status: "finished" }));
	const transport = createGcpSandboxGcsTransport({
		storage: env.storage,
		bucket: "b",
		prefix: "smithers/sandbox",
		runId: "R",
		sandboxId: "R-S",
		...overrides,
	});
	return { env, transport };
}

describe("createGcpSandboxGcsTransport", () => {
	test("maps a workdir path to <prefix>/<runId>/<sandboxId>/<sanitized-path>", () => {
		const { transport } = makeTransport();
		expect(transport.objectNameFor("/workspace/.smithers/sandbox-request.json")).toBe("smithers/sandbox/R/R-S/workspace/.smithers/sandbox-request.json");
	});

	test("same-basename paths in different dirs map to distinct objects and round-trip independently", async () => {
		const { transport } = makeTransport();
		const a = transport.objectNameFor("/workspace/a/config.json");
		const b = transport.objectNameFor("/workspace/b/config.json");
		expect(a).not.toBe(b);
		await transport.writeFile("/workspace/a/config.json", "AAA");
		await transport.writeFile("/workspace/b/config.json", "BBB");
		expect(await transport.readFile("/workspace/a/config.json")).toBe("AAA");
		expect(await transport.readFile("/workspace/b/config.json")).toBe("BBB");
	});

	test("percent-encodes segments so lossy collisions cannot occur", () => {
		const { transport } = makeTransport();
		// A space vs an underscore must not collapse to the same object.
		const spaced = transport.objectNameFor("/workspace/a b.json");
		const scored = transport.objectNameFor("/workspace/a_b.json");
		expect(spaced).not.toBe(scored);
		expect(spaced).toContain("a%20b.json");
	});

	test("path mapping is stable across calls", () => {
		const { transport } = makeTransport();
		const a = transport.objectNameFor("/workspace/a.txt");
		const b = transport.objectNameFor("/workspace/a.txt");
		expect(a).toBe(b);
	});

	test("writeFile uploads to the mapped object", async () => {
		const { env, transport } = makeTransport();
		await transport.writeFile("/workspace/.smithers/sandbox-request.json", "{\"ok\":1}");
		expect(env.objects.get("smithers/sandbox/R/R-S/workspace/.smithers/sandbox-request.json")).toBe("{\"ok\":1}");
	});

	test("readFile downloads and decodes the mapped object", async () => {
		const { env, transport } = makeTransport();
		env.objects.set("smithers/sandbox/R/R-S/workspace/result.json", "{\"done\":true}");
		const content = await transport.readFile("/workspace/result.json");
		expect(content).toBe("{\"done\":true}");
	});

	test("deleteAll removes every touched object", async () => {
		const { env, transport } = makeTransport();
		await transport.writeFile("/workspace/req.json", "1");
		await transport.writeFile("/workspace/res.json", "2");
		expect(env.objects.size).toBe(2);
		await transport.deleteAll();
		expect(env.objects.size).toBe(0);
	});

	test("trailing-slash prefix is normalized", () => {
		const { transport } = makeTransport({ prefix: "custom/prefix/" });
		expect(transport.prefix).toBe("custom/prefix");
		expect(transport.objectNameFor("/x/y.txt")).toBe("custom/prefix/R/R-S/x/y.txt");
	});
});

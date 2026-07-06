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
	test("maps a workdir path to <prefix>/<runId>/<sandboxId>/<basename>", () => {
		const { transport } = makeTransport();
		expect(transport.objectNameFor("/workspace/.smithers/sandbox-request.json")).toBe("smithers/sandbox/R/R-S/sandbox-request.json");
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
		expect(env.objects.get("smithers/sandbox/R/R-S/sandbox-request.json")).toBe("{\"ok\":1}");
	});

	test("readFile downloads and decodes the mapped object", async () => {
		const { env, transport } = makeTransport();
		env.objects.set("smithers/sandbox/R/R-S/result.json", "{\"done\":true}");
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
		expect(transport.objectNameFor("/x/y.txt")).toBe("custom/prefix/R/R-S/y.txt");
	});
});

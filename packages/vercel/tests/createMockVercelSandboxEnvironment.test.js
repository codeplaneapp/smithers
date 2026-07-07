import { describe, expect, test } from "bun:test";
import { createMockVercelSandboxEnvironment } from "../src/createMockVercelSandboxEnvironment.js";

const REQUEST_FILE = "/vercel/sandbox/.smithers/sandbox-request.json";
const RESULT_FILE = "/vercel/sandbox/.smithers/sandbox-result.json";

describe("createMockVercelSandboxEnvironment", () => {
	test("hands out deterministic sandbox ids", async () => {
		const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
		const a = await env.create({});
		const b = await env.create({});
		expect(a.sandboxId).toBe("vercel-sandbox-1");
		expect(b.sandboxId).toBe("vercel-sandbox-2");
		expect(env.sandboxes).toHaveLength(2);
	});

	test("supports a custom sandboxId prefix", async () => {
		const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }), { sandboxIdPrefix: "box" });
		const a = await env.create({});
		expect(a.sandboxId).toBe("box-1");
	});

	test("records create options", async () => {
		const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
		await env.create({ runtime: "node24", timeout: 1234 });
		expect(env.createCalls[0]).toMatchObject({ runtime: "node24", timeout: 1234 });
	});

	test("writeFiles stores decoded content; readFile returns a buffer", async () => {
		const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
		const sandbox = await env.create({});
		await sandbox.writeFiles([{ path: "/a.txt", content: Buffer.from("hello") }]);
		expect(sandbox.files.get("/a.txt")).toBe("hello");
		const read = await sandbox.readFile({ path: "/a.txt" });
		expect(Buffer.isBuffer(read)).toBe(true);
		expect(read.toString("utf-8")).toBe("hello");
	});

	test("runCommand parses the request file and passes command/env to the handler", async () => {
		let seen;
		const env = createMockVercelSandboxEnvironment((args) => {
			seen = args;
			return { status: "finished", output: { ok: true } };
		});
		const sandbox = await env.create({});
		await sandbox.writeFiles([{ path: REQUEST_FILE, content: Buffer.from(JSON.stringify({ runId: "r1", input: { x: 1 } })) }]);
		const done = await sandbox.runCommand({ cmd: "sh", args: ["-c", "node run.js"], cwd: "/vercel/sandbox", env: { FLAG: "on" } });
		expect(seen.command).toBe("node run.js");
		expect(seen.request).toMatchObject({ runId: "r1", input: { x: 1 } });
		expect(seen.env).toEqual({ FLAG: "on" });
		expect(seen.files instanceof Map).toBe(true);
		expect(done.exitCode).toBe(0);
		expect(await done.stdout()).toBe("");
		expect(await done.stderr()).toBe("");
		expect(JSON.parse(sandbox.files.get(RESULT_FILE))).toMatchObject({ status: "finished", output: { ok: true } });
	});

	test("stop and delete mark the sandbox torn down and fire onDestroy", async () => {
		let destroyed = 0;
		const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }), { onDestroy: () => { destroyed += 1; } });
		const stopped = await env.create({});
		await stopped.stop();
		expect(stopped.stopped).toBe(true);
		expect(stopped.destroyed).toBe(true);
		const deleted = await env.create({});
		await deleted.delete();
		expect(deleted.deleted).toBe(true);
		expect(destroyed).toBe(2);
	});

	test("runCommand after teardown rejects", async () => {
		const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
		const sandbox = await env.create({});
		await sandbox.delete();
		await expect(sandbox.runCommand({ cmd: "sh", args: ["-c", "echo hi"] })).rejects.toThrow(/torn down/);
	});

	test("extendTimeout and domain are recorded", async () => {
		const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
		const sandbox = await env.create({});
		await sandbox.extendTimeout(600_000);
		const domain = sandbox.domain(3000);
		expect(sandbox.extendTimeoutCalls).toEqual([600_000]);
		expect(sandbox.domainCalls).toEqual([3000]);
		expect(domain).toBe("https://vercel-sandbox-1-3000.vercel.run");
	});

	test("fault injection makes create reject", async () => {
		const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }), { fail: "create" });
		await expect(env.create({})).rejects.toThrow(/create failure/);
	});

	test("writeFiles stringifies a non-buffer object content via toString", async () => {
		const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
		const sandbox = await env.create({});
		await sandbox.writeFiles([{ path: "/obj.txt", content: { toString: () => "object-string" } }]);
		expect(sandbox.files.get("/obj.txt")).toBe("object-string");
	});

	test("writeFiles stringifies primitive (non-object) content via the fallback", async () => {
		const env = createMockVercelSandboxEnvironment(() => ({ status: "finished" }));
		const sandbox = await env.create({});
		await sandbox.writeFiles([{ path: "/num.txt", content: 42 }]);
		expect(sandbox.files.get("/num.txt")).toBe("42");
		await sandbox.writeFiles([{ path: "/nil.txt", content: null }]);
		expect(sandbox.files.get("/nil.txt")).toBe("");
	});

	test("fault injection makes runCommand and writeFiles reject", async () => {
		const execEnv = createMockVercelSandboxEnvironment(() => ({ status: "finished" }), { fail: ["exec", "writeFiles"] });
		const sandbox = await execEnv.create({});
		await expect(sandbox.writeFiles([{ path: "/x", content: Buffer.from("y") }])).rejects.toThrow(/writeFiles failure/);
		await expect(sandbox.runCommand({ cmd: "sh", args: ["-c", "echo"] })).rejects.toThrow(/runCommand failure/);
	});
});

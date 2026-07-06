import { describe, expect, test } from "bun:test";
import { createMockDaytonaSandboxEnvironment } from "../src/createMockDaytonaSandboxEnvironment.js";

const REQUEST_ENV = "SMITHERS_SANDBOX_REQUEST_PATH";
const RESULT_ENV = "SMITHERS_SANDBOX_RESULT_PATH";

describe("createMockDaytonaSandboxEnvironment", () => {
	test("create returns deterministic sandbox ids", async () => {
		const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }));
		const a = await env.create({});
		const b = await env.create({});
		expect(a.id).toBe("daytona-mock-0");
		expect(b.id).toBe("daytona-mock-1");
		expect(env.sandboxes.size).toBe(2);
	});

	test("records create options", async () => {
		const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }));
		await env.create({ image: "ubuntu", ephemeral: true });
		expect(env.createOptions[0]).toEqual({ image: "ubuntu", ephemeral: true });
	});

	test("fs stores uploaded files and downloads them back as a Buffer", async () => {
		const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }));
		const sandbox = await env.create({});
		await sandbox.fs.uploadFile(Buffer.from("hello world"), "/workspace/note.txt");
		const back = await sandbox.fs.downloadFile("/workspace/note.txt");
		expect(Buffer.isBuffer(back)).toBe(true);
		expect(back.toString("utf8")).toBe("hello world");
	});

	test("executeCommand invokes handler with command/request/files/env and writes result", async () => {
		let seen;
		const env = createMockDaytonaSandboxEnvironment((args) => {
			seen = args;
			return { status: "finished", output: { ok: 1 } };
		});
		const sandbox = await env.create({});
		await sandbox.fs.uploadFile(
			Buffer.from(JSON.stringify({ runId: "r1", sandboxId: "s1" })),
			"/workspace/.smithers/sandbox-request.json",
		);
		const res = await sandbox.process.executeCommand("run", "/workspace", {
			[REQUEST_ENV]: "/workspace/.smithers/sandbox-request.json",
			[RESULT_ENV]: "/workspace/.smithers/sandbox-result.json",
			EXTRA: "x",
		}, 60);
		expect(res).toEqual({ exitCode: 0, result: "" });
		expect(seen.command).toBe("run");
		expect(seen.request).toEqual({ runId: "r1", sandboxId: "s1" });
		expect(seen.env.EXTRA).toBe("x");
		expect(seen.files instanceof Map).toBe(true);
		const written = sandbox.files.get("/workspace/.smithers/sandbox-result.json");
		expect(JSON.parse(written)).toEqual({ status: "finished", output: { ok: 1 } });
	});

	test("delete marks the sandbox destroyed and fires onDestroy", async () => {
		let destroyed = false;
		const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }), { onDestroy: () => { destroyed = true; } });
		const sandbox = await env.create({});
		await env.delete(sandbox);
		expect(sandbox.destroyed).toBe(true);
		expect(destroyed).toBe(true);
	});

	test("executeCommand after delete rejects", async () => {
		const env = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }));
		const sandbox = await env.create({});
		await env.delete(sandbox);
		await expect(sandbox.process.executeCommand("run", "/workspace", {}, 60)).rejects.toThrow(/destroyed/);
	});

	test("fault injection makes create/exec/upload reject", async () => {
		const failCreate = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }), { failCreate: true });
		await expect(failCreate.create({})).rejects.toThrow(/create failed/);

		const failExec = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }), { failExec: true });
		const s1 = await failExec.create({});
		await expect(s1.process.executeCommand("run", "/workspace", {}, 60)).rejects.toThrow(/executeCommand failed/);

		const failUpload = createMockDaytonaSandboxEnvironment(() => ({ status: "finished" }), { failUpload: true });
		const s2 = await failUpload.create({});
		await expect(s2.fs.uploadFile(Buffer.from("x"), "/a")).rejects.toThrow(/uploadFile failed/);
	});
});

import { describe, expect, test } from "bun:test";
import { resolveAwsSdkClient } from "../src/resolveAwsSdkClient.js";

const FIXTURE = `${import.meta.dir}/fixtures/fakeAwsSdk.js`;

describe("resolveAwsSdkClient — injected surface", () => {
	test("returns an injected double untouched when it implements every method (no import)", async () => {
		const injected = {
			putObject: async () => ({ ok: "put" }),
			getObject: async () => ({ ok: "get" }),
		};
		const surface = await resolveAwsSdkClient({
			injected,
			// A module name that would fail to import — proving the SDK is never touched.
			moduleName: "@aws-sdk/definitely-not-installed",
			clientExport: "Whatever",
			methods: ["putObject", "getObject"],
		});
		expect(surface).toBe(injected);
		expect(await surface.putObject({})).toEqual({ ok: "put" });
	});
});

describe("resolveAwsSdkClient — real-import construction path", () => {
	test("constructs the client and wraps each method as client.send(new <Method>Command(input))", async () => {
		const surface = await resolveAwsSdkClient({
			moduleName: FIXTURE,
			clientExport: "Client",
			methods: ["putObject", "getObject"],
			clientOptions: { region: "us-east-1" },
		});
		const putRes = await surface.putObject({ Key: "k", Body: "b" });
		expect(putRes.commandName).toBe("PutObjectCommand");
		expect(putRes.echoed).toEqual({ Key: "k", Body: "b" });
		expect(putRes.viaClient).toBe(true);
		const getRes = await surface.getObject({ Key: "k2" });
		expect(getRes.commandName).toBe("GetObjectCommand");
		expect(getRes.echoed).toEqual({ Key: "k2" });
	});

	test("reuses an injected raw send() client (bypasses new Client) when it lacks the flat methods", async () => {
		/** @type {unknown[]} */
		const sent = [];
		/** @type {unknown[]} */
		const sentHandlerOptions = [];
		const injected = {
			// No putObject method, so the fast-path bail-out does not trigger, but it
			// carries a `.send` the wrapper reuses instead of constructing a client.
			send: async (/** @type {{ input: unknown }} */ command, handlerOptions) => {
				sent.push(command);
				sentHandlerOptions.push(handlerOptions);
				return { fromInjected: command.input };
			},
		};
		const surface = await resolveAwsSdkClient({
			injected,
			moduleName: FIXTURE,
			clientExport: "Client",
			methods: ["putObject"],
		});
		const controller = new AbortController();
		const res = await surface.putObject({ Key: "reused" }, { abortSignal: controller.signal });
		expect(res).toEqual({ fromInjected: { Key: "reused" } });
		expect(sent.length).toBe(1);
		expect(sentHandlerOptions).toEqual([{ abortSignal: controller.signal }]);
	});
});

describe("resolveAwsSdkClient — failure paths", () => {
	test("throws INVALID_INPUT with install guidance when the module cannot be imported", async () => {
		let message = "";
		let code = "";
		try {
			await resolveAwsSdkClient({
				moduleName: `${import.meta.dir}/fixtures/does-not-exist.js`,
				clientExport: "Client",
				methods: ["putObject"],
			});
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
			code = /** @type {any} */ (error)?.code ?? "";
		}
		expect(code).toBe("INVALID_INPUT");
		expect(message).toMatch(/needs/);
		expect(message).toMatch(/optional dependency/);
	});

	test("throws when the module does not export the requested client", async () => {
		await expect(
			resolveAwsSdkClient({
				moduleName: FIXTURE,
				clientExport: "NoSuchClient",
				methods: ["putObject"],
			}),
		).rejects.toThrow(/does not export NoSuchClient/);
	});

	test("throws when a required <Method>Command export is missing", async () => {
		await expect(
			resolveAwsSdkClient({
				moduleName: FIXTURE,
				clientExport: "Client",
				methods: ["deleteObjects"],
			}),
		).rejects.toThrow(/does not export DeleteObjectsCommand/);
	});
});

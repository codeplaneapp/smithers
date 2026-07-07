import { describe, expect, test } from "bun:test";
import { createAwsSandboxS3Transport } from "../src/index.js";

/** Minimal in-memory S3 double. */
function memoryS3() {
	/** @type {Map<string, string>} */
	const store = new Map();
	return {
		store,
		/** @param {Record<string, any>} input */
		async putObject(input) {
			store.set(String(input.Key), String(input.Body));
			return {};
		},
		/** @param {Record<string, any>} input */
		async getObject(input) {
			const key = String(input.Key);
			if (!store.has(key)) throw new Error(`NoSuchKey: ${key}`);
			return { Body: store.get(key) };
		},
		/** @param {Record<string, any>} input */
		async deleteObjects(input) {
			for (const obj of input?.Delete?.Objects ?? []) store.delete(String(obj.Key));
			return {};
		},
	};
}

describe("createAwsSandboxS3Transport — path mapping edges", () => {
	test("a path outside the workdir keeps its absolute tail (leading slashes stripped)", () => {
		const transport = createAwsSandboxS3Transport({ s3: memoryS3(), bucket: "b", prefix: "p", workdir: "/workspace" });
		expect(transport.keyForPath("/etc/hosts")).toBe(`p/${encodeURIComponent("etc/hosts")}`);
	});

	test("a path equal to the workdir maps to the empty relative key", () => {
		const transport = createAwsSandboxS3Transport({ s3: memoryS3(), bucket: "b", prefix: "p", workdir: "/workspace" });
		expect(transport.keyForPath("/workspace")).toBe("p/");
	});

	test("writtenKeys() reports every uploaded key", async () => {
		const transport = createAwsSandboxS3Transport({ s3: memoryS3(), bucket: "b", prefix: "p", workdir: "/workspace" });
		expect(transport.writtenKeys()).toEqual([]);
		await transport.writeFile("/workspace/a.txt", "AAA");
		await transport.writeFile("/workspace/b.txt", "BBB");
		expect(transport.writtenKeys()).toEqual([`p/${encodeURIComponent("a.txt")}`, `p/${encodeURIComponent("b.txt")}`]);
	});
});

describe("createAwsSandboxS3Transport — readFile Body decoding", () => {
	/** @param {unknown} body */
	function transportReturning(body) {
		const s3 = {
			async putObject() {
				return {};
			},
			async getObject() {
				return { Body: body };
			},
			async deleteObjects() {
				return {};
			},
		};
		return createAwsSandboxS3Transport({ s3, bucket: "b", prefix: "p", workdir: "/workspace" });
	}

	test("decodes a Uint8Array Body via TextDecoder", async () => {
		const bytes = new TextEncoder().encode("bytes-body");
		expect(await transportReturning(bytes).readFile("/workspace/x")).toBe("bytes-body");
	});

	test("returns empty string when Body is null or undefined", async () => {
		expect(await transportReturning(null).readFile("/workspace/x")).toBe("");
		expect(await transportReturning(undefined).readFile("/workspace/x")).toBe("");
	});

	test("stringifies an unrecognized Body that lacks transformToString", async () => {
		expect(await transportReturning(12345).readFile("/workspace/x")).toBe("12345");
	});

	test("readFile surfaces a download failure as SANDBOX_EXECUTION_FAILED with secrets scrubbed", async () => {
		const s3 = {
			async putObject() {
				return {};
			},
			async getObject() {
				throw new Error("access denied for DLSECRET");
			},
			async deleteObjects() {
				return {};
			},
		};
		const transport = createAwsSandboxS3Transport({ s3, bucket: "b", prefix: "p", workdir: "/workspace", secrets: ["DLSECRET"] });
		let message = "";
		try {
			await transport.readFile("/workspace/x");
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toMatch(/S3 download failed/);
		expect(message).not.toContain("DLSECRET");
	});
});

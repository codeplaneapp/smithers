import { describe, expect, spyOn, test } from "bun:test";
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
    const transport = createAwsSandboxS3Transport({
      s3,
      bucket: "b",
      prefix: "p",
      workdir: "/workspace",
      secrets: ["DLSECRET"],
    });
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

describe("createAwsSandboxS3Transport — retryable cleanup", () => {
  test("retries every tracked key after deleteObjects rejects", async () => {
    const s3 = memoryS3();
    const attempts = [];
    let fail = true;
    s3.deleteObjects = async (input) => {
      attempts.push(input.Delete.Objects.map((object) => object.Key));
      if (fail) {
        fail = false;
        throw new Error("temporary S3 failure");
      }
      return {};
    };
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const transport = createAwsSandboxS3Transport({ s3, bucket: "b", prefix: "p", workdir: "/workspace" });
      await transport.writeFile("/workspace/a.txt", "A");
      await transport.writeFile("/workspace/b.txt", "B");

      await transport.deleteAll();
      expect(transport.writtenKeys()).toEqual(["p/a.txt", "p/b.txt"]);
      await transport.deleteAll();
      await transport.deleteAll();

      expect(attempts).toEqual([
        ["p/a.txt", "p/b.txt"],
        ["p/a.txt", "p/b.txt"],
      ]);
      expect(transport.writtenKeys()).toEqual([]);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  test("retries only keys reported as per-object failures", async () => {
    const s3 = memoryS3();
    const attempts = [];
    const failedKey = "p/b.txt";
    s3.deleteObjects = async (input) => {
      const keys = input.Delete.Objects.map((object) => object.Key);
      attempts.push(keys);
      return attempts.length === 1 ? { Errors: [{ Key: failedKey, Code: "AccessDenied" }] } : {};
    };
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const transport = createAwsSandboxS3Transport({ s3, bucket: "b", prefix: "p", workdir: "/workspace" });
      await transport.writeFile("/workspace/a.txt", "A");
      await transport.writeFile("/workspace/b.txt", "B");
      await transport.writeFile("/workspace/c.txt", "C");

      await transport.deleteAll();
      expect(transport.writtenKeys()).toEqual([failedKey]);
      await transport.deleteAll();

      expect(attempts).toEqual([["p/a.txt", "p/b.txt", "p/c.txt"], [failedKey]]);
      expect(transport.writtenKeys()).toEqual([]);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });
});

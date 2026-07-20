import { describe, expect, test } from "bun:test";
import { createHttpTool } from "../src/http/createHttpTool.js";

const callOptions = { toolCallId: "url-scheme-test", messages: [] };

describe("createHttpTool URL schemes", () => {
  test("accepts HTTP(S) and rejects non-HTTP(S) input", () => {
    const schema = createHttpTool().inputSchema;

    expect(schema.safeParse({ url: "http://example.test/" }).success).toBe(true);
    expect(schema.safeParse({ url: "https://example.test/" }).success).toBe(true);
    for (const url of ["file:///etc/hosts", "data:text/plain,secret", "ftp://example.test/file"]) {
      expect(schema.safeParse({ url }).success).toBe(false);
    }
  });

  test("rejects non-HTTP(S) URLs before fetch or header processing", async () => {
    const tool = createHttpTool({ defaultHeaders: { authorization: "secret" } });

    for (const url of ["file:///etc/hosts", "data:text/plain,secret", "ftp://example.test/file"]) {
      await expect(tool.execute({ url, query: { key: "value" } }, callOptions)).rejects.toThrow(
        /does not support URL protocol/,
      );
    }
  });
});

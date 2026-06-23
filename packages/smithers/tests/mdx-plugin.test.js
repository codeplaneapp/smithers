import { describe, expect, test } from "bun:test";
import { mdxPlugin } from "../src/mdx-plugin.js";

describe("mdxPlugin", () => {
  test("is exported as a function", () => {
    expect(typeof mdxPlugin).toBe("function");
  });

  test("registers a Bun plugin without throwing", () => {
    // mdxPlugin() calls bun's plugin() with the @mdx-js/esbuild plugin.
    // In test context, bun's plugin() is a no-op but should not throw.
    expect(() => mdxPlugin()).not.toThrow();
  });
});

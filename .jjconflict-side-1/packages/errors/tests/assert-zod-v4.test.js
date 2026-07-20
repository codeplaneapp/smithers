import { describe, expect, test } from "bun:test";
import { assertZodV4 } from "../src/assertZodV4.js";
import { isSmithersError } from "../src/isSmithersError.js";

// Pure-helper contract test. Uses fabricated schema-shaped objects so it needs
// no zod dependency and stays CI-safe (no agent CLI / browser). The real-zod
// integration is covered in packages/db/tests/assert-zod-v4.test.js.
describe("assertZodV4", () => {
  test("accepts a Zod v4-shaped schema (no throw)", () => {
    const v4 = { _zod: { version: { major: 4, minor: 4, patch: 3 } }, parse() {} };
    expect(() => assertZodV4(v4)).not.toThrow();
    expect(() => assertZodV4(v4, "myOutput")).not.toThrow();
  });

  test("throws a clear, actionable error on a Zod v3-shaped schema", () => {
    const v3 = { _def: { typeName: "ZodObject" }, shape: {}, parse() {} };
    expect(() => assertZodV4(v3)).toThrow(/requires Zod v4/);
  });

  test("error is a SmithersError(INVALID_INPUT) that names the schema key", () => {
    const v3 = { _def: { typeName: "ZodObject" }, shape: {}, parse() {} };
    let caught;
    try {
      assertZodV4(v3, "review");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isSmithersError(caught)).toBe(true);
    expect(caught.code).toBe("INVALID_INPUT");
    expect(caught.message).toContain('for "review"');
    expect(caught.message).toContain('"zod": "^4"');
    expect(caught.details?.schema).toBe("review");
  });

  test("does not throw on non-schema values (plain object, null, primitives)", () => {
    expect(() => assertZodV4({ foo: 1 })).not.toThrow();
    expect(() => assertZodV4(null)).not.toThrow();
    expect(() => assertZodV4(undefined)).not.toThrow();
    expect(() => assertZodV4("nope")).not.toThrow();
    expect(() => assertZodV4(42)).not.toThrow();
  });
});

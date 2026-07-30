import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { schemaMock } from "../src/schemaMock.ts";

describe("schemaMock constrained candidates", () => {
  test("chooses a fractional value inside combined exclusive bounds", () => {
    const schema = z.number().gt(0).lt(0.5);
    const value = schemaMock(schema);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(0.5);

    const negativeSchema = z.number().gt(-0.5).lt(0);
    const negativeValue = schemaMock(negativeSchema);
    expect(negativeValue).toBeGreaterThan(-0.5);
    expect(negativeValue).toBeLessThan(0);
  });

  test("falls through when the legacy generator rejects a primitive schema", () => {
    expect(z.string().safeParse(schemaMock(z.string())).success).toBe(true);
    expect(z.number().safeParse(schemaMock(z.number())).success).toBe(true);
  });

  test("satisfies multipleOf and common regex refinements", () => {
    const schema = z.object({
      quantity: z.number().gt(0).lt(1).multipleOf(0.125),
      integerQuantity: z.number().int().gte(0.1).lte(2).multipleOf(0.00001),
      code: z.string().regex(/^item-\d{3}$/),
    });
    const value = schemaMock(schema);
    expect(schema.safeParse(value)).toEqual(expect.objectContaining({ success: true }));
    expect(value.quantity % 0.125).toBe(0);
    expect(Number.isInteger(value.integerQuantity)).toBe(true);
    expect(value.integerQuantity % 0.00001).toBeCloseTo(0);
    expect(value.code).toMatch(/^item-\d{3}$/);
  });
});

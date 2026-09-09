/**
 * Provides a typecheck-only stand-in for the Bun test API used by this package.
 *
 * The package uses Shiki only to generate checked-in themes; it does not install
 * Bun's type declarations. Bun never loads this declaration when it runs the
 * suite.
 */
/// <reference types="node" />

declare module "bun:test" {
  interface Matchers {
    readonly not: Matchers;

    toBe(expected: unknown): void;
    toBeCloseTo(expected: number, precision?: number): void;
    toBeDefined(): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toBeNull(): void;
    toContain(expected: unknown): void;
    toEqual(expected: unknown): void;
    toHaveLength(expected: number): void;
    toMatch(expected: string | RegExp): void;
    toStartWith(expected: string): void;
    toThrow(expected?: unknown): void;
  }

  export function describe(name: string, body: () => void): void;
  export function test(name: string, body: () => void | Promise<void>, timeout?: number): void;
  export function expect(actual: unknown, message?: string): Matchers;
}

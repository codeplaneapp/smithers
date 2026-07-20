/// <reference path="../types/bun-test-shim.d.ts" />

import type { Sim } from "./simulate.ts";

type MatcherContext = {
  isNot?: boolean;
};

type MatcherResult = {
  pass: boolean;
  message: () => string;
};

type SimLike = Sim | {
  executed?: readonly string[];
  status?: string;
};

function executedOf(received: SimLike): readonly string[] {
  return Array.isArray(received.executed) ? received.executed : [];
}

function formatValue(value: unknown): string {
  return JSON.stringify(value);
}

function hasSubsequence(actual: readonly string[], expected: readonly string[]): boolean {
  let expectedIndex = 0;

  for (const id of actual) {
    if (id === expected[expectedIndex]) {
      expectedIndex += 1;
    }

    if (expectedIndex === expected.length) {
      return true;
    }
  }

  return expectedIndex === expected.length;
}

export function toHaveExecuted(
  this: MatcherContext | void,
  received: SimLike,
  ids: string[],
): MatcherResult {
  const executed = executedOf(received);
  const missing = ids.filter((id) => !executed.includes(id));
  const pass = missing.length === 0;

  return {
    pass,
    message: (): string => pass
      ? `Expected simulation not to have executed ${formatValue(ids)}, but actual executed nodes were ${formatValue(executed)}.`
      : `Expected simulation to have executed ${formatValue(ids)}, but missing ids were ${formatValue(missing)}. Actual executed nodes were ${formatValue(executed)}.`,
  };
}

export function toHaveExecutedInOrder(
  this: MatcherContext | void,
  received: SimLike,
  ids: string[],
): MatcherResult {
  const executed = executedOf(received);
  const pass = hasSubsequence(executed, ids);

  return {
    pass,
    message: (): string => pass
      ? `Expected simulation not to have executed in order ${formatValue(ids)}, but actual executed order was ${formatValue(executed)}.`
      : `Expected simulation to have executed in order ${formatValue(ids)}, but actual executed order was ${formatValue(executed)}.`,
  };
}

export function toHaveFinished(
  this: MatcherContext | void,
  received: SimLike,
): MatcherResult {
  const pass = received.status === "finished";

  return {
    pass,
    message: (): string => pass
      ? 'Expected simulation not to have finished, but status was "finished".'
      : `Expected simulation to have finished, but status was ${formatValue(received.status)}.`,
  };
}

export const simMatchers: {
  toHaveExecuted: typeof toHaveExecuted;
  toHaveExecutedInOrder: typeof toHaveExecutedInOrder;
  toHaveFinished: typeof toHaveFinished;
} = { toHaveExecuted, toHaveExecutedInOrder, toHaveFinished };

// Augment `bun:test`'s `Matchers` interface so `expect(sim).toHaveExecuted(...)`
// et al. typecheck after `expect.extend(simMatchers)`. This lives in a tsup
// entry (`matchers.ts`) so the augmentation is re-emitted into `matchers.d.ts`
// on every build; a hand-authored `.d.ts` would be wiped by `clean-dts` and
// silently dropped from the published package. The augmentation applies wherever
// the matchers module is imported (i.e. wherever `simMatchers` is used).
declare module "bun:test" {
  interface Matchers<T> {
    toHaveExecuted(ids: string[]): void;
    toHaveExecutedInOrder(ids: string[]): void;
    toHaveFinished(): void;
  }
}

// Compile-time guard (fully erased at runtime): fails `pnpm -C packages/testing
// typecheck` — which covers `src/**/*` — if the augmentation above ever stops
// applying to `bun:test`'s `Matchers`, e.g. because a build step dropped it. This
// is what makes the type augmentation gated rather than silently ship-or-not.
type _Assert<T extends true> = T;
type _AugmentationApplies = _Assert<
  import("bun:test").Matchers<unknown> extends {
    toHaveExecuted(ids: string[]): void;
    toHaveExecutedInOrder(ids: string[]): void;
    toHaveFinished(): void;
  }
    ? true
    : false
>;

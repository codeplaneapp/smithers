import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import {
  fromPromise,
  fromSync,
  ignoreSyncError,
  toError,
} from "../src/interop.ts";
import { SmithersError } from "../src/errors.ts";

describe("interop", () => {
  test("wraps promise failures as SmithersError", async () => {
    const exit = await Effect.runPromiseExit(
      fromPromise("fetch", () => Promise.reject(new Error("network"))),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(SmithersError);
        expect(failure.value.message).toContain("fetch: network");
      }
    }
  });

  test("captures sync values and errors", async () => {
    await expect(Effect.runPromise(fromSync("add", () => 2 + 2))).resolves.toBe(4);
    const error = toError("bad", "parse");
    expect(error.message).toContain("parse: bad");
  });

  test("ignoreSyncError swallows cleanup failures", async () => {
    let called = false;
    await Effect.runPromise(
      ignoreSyncError("cleanup", () => {
        called = true;
        throw new Error("ignored");
      }),
    );
    expect(called).toBe(true);
  });
});

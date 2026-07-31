import { describe, expect, test } from "bun:test";
import { SchemaParser } from "effect";
import { DB_RUN_ALLOWED_STATUSES } from "@smithers-orchestrator/db/adapter";
import { CancelResultSchema, RunStatusSchema, SignalResultSchema } from "../src/effect/rpc-schema.js";

describe("Effect RPC schemas", () => {
  test("accepts every durable run status", () => {
    const decode = SchemaParser.decodeSync(RunStatusSchema);
    const statuses = [...DB_RUN_ALLOWED_STATUSES];
    expect(statuses.map(decode)).toEqual(statuses);
    expect(decode("waiting-quota")).toBe("waiting-quota");
    expect(() => decode("unknown")).toThrow();
  });

  test("accepts every cancel result status", () => {
    const decode = SchemaParser.decodeSync(CancelResultSchema);
    for (const status of ["cancelling", "cancelled", "already-terminal", "not-found"]) {
      expect(
        decode({
          runId: "run",
          status,
          won: false,
          repaired: false,
        }).status,
      ).toBe(status);
    }
    expect(() =>
      decode({
        runId: "run",
        status: "unknown",
        won: false,
        repaired: false,
      }),
    ).toThrow();
  });

  test("accepts both signal result statuses", () => {
    const decode = SchemaParser.decodeSync(SignalResultSchema);
    for (const status of ["signalled", "ignored"]) {
      expect(
        decode({
          runId: "run",
          signalName: "deploy.ready",
          delivered: status === "signalled",
          status,
        }).status,
      ).toBe(status);
    }
    expect(() =>
      decode({
        runId: "run",
        signalName: "deploy.ready",
        delivered: false,
        status: "unknown",
      }),
    ).toThrow();
  });
});

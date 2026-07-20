/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import React from "react";
import { Branch } from "../src/components/Branch.js";

describe("<Branch> children guard", () => {
  const task = React.createElement("smithers:task", { id: "t" });

  test("throws a clear error when children are passed", () => {
    expect(() => Branch({ if: true, then: task, children: task })).toThrow(/does not take children/);
  });

  test("throws even on a skipped branch (catches the mistake regardless)", () => {
    expect(() => Branch({ if: true, then: task, skipIf: true, children: task })).toThrow(/does not take children/);
  });

  test("the then/else prop form still works", () => {
    expect(() => Branch({ if: true, then: task })).not.toThrow();
    const el = Branch({ if: false, then: task, else: null });
    expect(el?.type).toBe("smithers:branch");
  });
});

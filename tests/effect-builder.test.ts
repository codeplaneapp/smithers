import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { Smithers } from "../src/index";

// The builder module's internal functions (durationToMs, deriveRetryCount, etc.)
// are not directly exported. We test them indirectly through the Smithers.sqlite()
// API and by constructing workflows that exercise the builder logic.

// ---------------------------------------------------------------------------
// Smithers.sqlite — public API for the Effect builder
// ---------------------------------------------------------------------------

describe("Smithers.sqlite", () => {
  test("creates a workflow builder with name and input", () => {
    const wf = Smithers.sqlite({
      name: "test-workflow",
      input: Schema.Struct({ prompt: Schema.String }),
    });
    expect(wf).toBeDefined();
    expect(typeof wf.build).toBe("function");
  });

  test("build returns a BuiltSmithersWorkflow with execute method", () => {
    const wf = Smithers.sqlite({
      name: "test-wf",
      input: Schema.Struct({ text: Schema.String }),
    });

    const built = wf.build(($) => {
      const step = $.step("greet", {
        output: Schema.Struct({ greeting: Schema.String }),
        run: (ctx) => ({ greeting: `Hello ${(ctx.input as any).text}` }),
      });
      return step;
    });

    expect(built).toBeDefined();
    expect(typeof built.execute).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Builder API — step, sequence, parallel, loop
// ---------------------------------------------------------------------------

describe("Builder API via Smithers.sqlite build callback", () => {
  test("creates step nodes with correct properties", () => {
    const wf = Smithers.sqlite({
      name: "test",
      input: Schema.Struct({ x: Schema.Number }),
    });

    let capturedStep: any;
    wf.build(($) => {
      capturedStep = $.step("compute", {
        output: Schema.Struct({ result: Schema.Number }),
        run: () => ({ result: 42 }),
      });
      return capturedStep;
    });

    expect(capturedStep.kind).toBe("step");
    expect(capturedStep.id).toBe("compute");
    expect(capturedStep.localId).toBe("compute");
    expect(capturedStep.tableName).toMatch(/^smithers_/);
    expect(capturedStep.retries).toBe(0);
    expect(capturedStep.timeoutMs).toBeNull();
  });

  test("creates sequence node from multiple steps", () => {
    const wf = Smithers.sqlite({
      name: "test",
      input: Schema.Struct({ x: Schema.Number }),
    });

    let capturedSeq: any;
    wf.build(($) => {
      const a = $.step("a", {
        output: Schema.Struct({ v: Schema.Number }),
        run: () => ({ v: 1 }),
      });
      const b = $.step("b", {
        output: Schema.Struct({ v: Schema.Number }),
        run: () => ({ v: 2 }),
      });
      capturedSeq = $.sequence(a, b);
      return capturedSeq;
    });

    expect(capturedSeq.kind).toBe("sequence");
    expect(capturedSeq.children).toHaveLength(2);
  });

  test("creates parallel node with maxConcurrency", () => {
    const wf = Smithers.sqlite({
      name: "test",
      input: Schema.Struct({ x: Schema.Number }),
    });

    let capturedPar: any;
    wf.build(($) => {
      const a = $.step("a", {
        output: Schema.Struct({ v: Schema.Number }),
        run: () => ({ v: 1 }),
      });
      const b = $.step("b", {
        output: Schema.Struct({ v: Schema.Number }),
        run: () => ({ v: 2 }),
      });
      capturedPar = $.parallel(a, b, { maxConcurrency: 3 });
      return capturedPar;
    });

    expect(capturedPar.kind).toBe("parallel");
    expect(capturedPar.maxConcurrency).toBe(3);
    expect(capturedPar.children).toHaveLength(2);
  });

  test("creates parallel node without maxConcurrency", () => {
    const wf = Smithers.sqlite({
      name: "test",
      input: Schema.Struct({ x: Schema.Number }),
    });

    let capturedPar: any;
    wf.build(($) => {
      const a = $.step("a", {
        output: Schema.Struct({ v: Schema.Number }),
        run: () => ({ v: 1 }),
      });
      capturedPar = $.parallel(a);
      return capturedPar;
    });

    expect(capturedPar.kind).toBe("parallel");
    expect(capturedPar.maxConcurrency).toBeUndefined();
  });

  test("creates loop node with until condition", () => {
    const wf = Smithers.sqlite({
      name: "test",
      input: Schema.Struct({ x: Schema.Number }),
    });

    let capturedLoop: any;
    wf.build(($) => {
      const step = $.step("iterate", {
        output: Schema.Struct({ count: Schema.Number }),
        run: () => ({ count: 1 }),
      });
      capturedLoop = $.loop({
        id: "main-loop",
        children: step,
        until: (outputs) => (outputs as any).count >= 10,
        maxIterations: 20,
        onMaxReached: "return-last",
      });
      return capturedLoop;
    });

    expect(capturedLoop.kind).toBe("loop");
    expect(capturedLoop.id).toBe("main-loop");
    expect(capturedLoop.maxIterations).toBe(20);
    expect(capturedLoop.onMaxReached).toBe("return-last");
  });

  test("creates approval node with correct defaults", () => {
    const wf = Smithers.sqlite({
      name: "test",
      input: Schema.Struct({ x: Schema.Number }),
    });

    let capturedApproval: any;
    wf.build(($) => {
      capturedApproval = $.approval("review", {
        request: () => ({ title: "Please review" }),
      });
      return capturedApproval;
    });

    expect(capturedApproval.kind).toBe("approval");
    expect(capturedApproval.id).toBe("review");
    expect(capturedApproval.onDeny).toBe("fail");
    expect(capturedApproval.retries).toBe(0);
    expect(capturedApproval.timeoutMs).toBeNull();
  });

  test("creates approval with custom onDeny", () => {
    const wf = Smithers.sqlite({
      name: "test",
      input: Schema.Struct({ x: Schema.Number }),
    });

    let capturedApproval: any;
    wf.build(($) => {
      capturedApproval = $.approval("review", {
        request: () => ({ title: "Review" }),
        onDeny: "continue",
      });
      return capturedApproval;
    });

    expect(capturedApproval.onDeny).toBe("continue");
  });

  test("step with retry count wires correctly", () => {
    const wf = Smithers.sqlite({
      name: "test",
      input: Schema.Struct({ x: Schema.Number }),
    });

    let handle: any;
    wf.build(($) => {
      handle = $.step("s", {
        output: Schema.Struct({ v: Schema.Number }),
        run: () => ({ v: 1 }),
        retry: 3,
      });
      return handle;
    });

    expect(handle.retries).toBe(3);
  });

  test("step with maxAttempts retry config wires correctly", () => {
    const wf = Smithers.sqlite({
      name: "test",
      input: Schema.Struct({ x: Schema.Number }),
    });

    let handle: any;
    wf.build(($) => {
      handle = $.step("s", {
        output: Schema.Struct({ v: Schema.Number }),
        run: () => ({ v: 1 }),
        retry: { maxAttempts: 5, backoff: "exponential", initialDelay: "1s" },
      });
      return handle;
    });

    expect(handle.retries).toBe(4);
    expect(handle.retryPolicy?.backoff).toBe("exponential");
    expect(handle.retryPolicy?.initialDelayMs).toBe(1000);
  });

  test("step with timeout string wires correctly", () => {
    const wf = Smithers.sqlite({
      name: "test",
      input: Schema.Struct({ x: Schema.Number }),
    });

    let handle: any;
    wf.build(($) => {
      handle = $.step("s", {
        output: Schema.Struct({ v: Schema.Number }),
        run: () => ({ v: 1 }),
        timeout: "30s",
      });
      return handle;
    });

    expect(handle.timeoutMs).toBe(30_000);
  });

  test("step with numeric timeout wires correctly", () => {
    const wf = Smithers.sqlite({
      name: "test",
      input: Schema.Struct({ x: Schema.Number }),
    });

    let handle: any;
    wf.build(($) => {
      handle = $.step("s", {
        output: Schema.Struct({ v: Schema.Number }),
        run: () => ({ v: 1 }),
        timeout: 5000,
      });
      return handle;
    });

    expect(handle.timeoutMs).toBe(5000);
  });

  test("step with needs dependency wiring", () => {
    const wf = Smithers.sqlite({
      name: "test",
      input: Schema.Struct({ x: Schema.Number }),
    });

    let stepB: any;
    wf.build(($) => {
      const a = $.step("a", {
        output: Schema.Struct({ v: Schema.Number }),
        run: () => ({ v: 1 }),
      });
      stepB = $.step("b", {
        output: Schema.Struct({ w: Schema.Number }),
        run: () => ({ w: 2 }),
        needs: { dep: a },
      });
      return $.sequence(a, stepB);
    });

    expect(stepB.needs).toBeDefined();
    expect(stepB.needs.dep).toBeDefined();
    expect(stepB.needs.dep.id).toBe("a");
  });

  test("match node construction", () => {
    const wf = Smithers.sqlite({
      name: "test",
      input: Schema.Struct({ x: Schema.Number }),
    });

    let capturedMatch: any;
    wf.build(($) => {
      const source = $.step("source", {
        output: Schema.Struct({ val: Schema.Number }),
        run: () => ({ val: 5 }),
      });
      const thenBranch = $.step("then", {
        output: Schema.Struct({ r: Schema.String }),
        run: () => ({ r: "yes" }),
      });
      capturedMatch = $.match(source, {
        when: (v: any) => v.val > 3,
        then: () => thenBranch,
      });
      return $.sequence(source, capturedMatch);
    });

    expect(capturedMatch.kind).toBe("match");
    expect(capturedMatch.source.id).toBe("source");
  });

  test("table name sanitizes special characters", () => {
    const wf = Smithers.sqlite({
      name: "test",
      input: Schema.Struct({ x: Schema.Number }),
    });

    let handle: any;
    wf.build(($) => {
      handle = $.step("my-special_step!2", {
        output: Schema.Struct({ v: Schema.Number }),
        run: () => ({ v: 1 }),
      });
      return handle;
    });

    expect(handle.tableName).toMatch(/^smithers_/);
    // Should only contain lowercase letters, numbers, and underscores
    expect(handle.tableName).toMatch(/^[a-z0-9_]+$/);
  });
});

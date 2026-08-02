/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { Workflow, Task, renderFrame, runWorkflow } from "smthrs";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";

describe("workflow input schema defaults", () => {
  test("applies input schema defaults before ctx.input is read", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      input: z.object({
        lruLimit: z.number().default(2),
        label: z.string().default("defaulted"),
      }),
      out: z.object({
        lruLimit: z.number(),
        sliceLength: z.number(),
        label: z.string(),
      }),
    });
    try {
      const workflow = smithers((ctx) => (
        <Workflow name="input-defaults">
          <Task id="t" output={outputs.out}>
            {{
              lruLimit: ctx.input.lruLimit,
              sliceLength: [1, 2, 3].slice(0, ctx.input.lruLimit).length,
              label: ctx.input.label,
            }}
          </Task>
        </Workflow>
      ));

      const r = await Effect.runPromise(runWorkflow(workflow, { input: {} }));

      expect(r.status).toBe("finished");
      const rows = db.select().from(tables.out).all();
      expect(rows[0]).toMatchObject({
        lruLimit: 2,
        sliceLength: 2,
        label: "defaulted",
      });
    } finally {
      cleanup();
    }
  });
  test("applies defaults and transforms to renderFrame without mutating its context", async () => {
    const { smithers, cleanup } = createTestSmithers({
      input: z.object({
        tickets: z.array(z.string()).default([]),
        label: z.string().transform((value) => value.toUpperCase()),
      }),
    });
    let renderedInput;
    const workflow = smithers((ctx) => {
      renderedInput = ctx.input;
      return <Workflow name="preview-defaults" />;
    });
    const input = { label: "preview" };
    const ctx = { runId: "preview-defaults", iteration: 0, input, outputs: {} };
    try {
      await Effect.runPromise(renderFrame(workflow, ctx));
      expect(renderedInput).toEqual({ tickets: [], label: "PREVIEW" });
      expect(ctx.input).toBe(input);
      expect(ctx.input).toEqual({ label: "preview" });
    } finally {
      cleanup();
    }
  });
  test("explicit preview input overrides schema defaults", async () => {
    const { smithers, cleanup } = createTestSmithers({
      input: z.object({ tickets: z.array(z.string()).default([]) }),
    });
    let tickets;
    const workflow = smithers((ctx) => {
      tickets = ctx.input.tickets;
      return <Workflow name="preview-explicit" />;
    });
    try {
      await Effect.runPromise(
        renderFrame(workflow, {
          runId: "preview-explicit",
          iteration: 0,
          input: { tickets: ["one"] },
          outputs: {},
        }),
      );
      expect(tickets).toEqual(["one"]);
    } finally {
      cleanup();
    }
  });
  test("does not reapply transforms to persisted preview input", async () => {
    const { smithers, cleanup } = createTestSmithers({
      input: z.object({ label: z.string().transform((value) => `${value}!`) }),
    });
    let label;
    const workflow = smithers((ctx) => {
      label = ctx.input.label;
      return <Workflow name="preview-persisted" />;
    });
    try {
      await Effect.runPromise(
        renderFrame(
          workflow,
          {
            runId: "preview-persisted",
            iteration: 0,
            input: { label: "already-parsed!" },
            outputs: {},
          },
          { inputAlreadyNormalized: true },
        ),
      );
      expect(label).toBe("already-parsed!");
    } finally {
      cleanup();
    }
  });
  test("can apply defaults while omitting required graph-preview fields", async () => {
    const { smithers, cleanup } = createTestSmithers({
      input: z.object({
        requiredAtRuntime: z.string(),
        tickets: z.array(z.string()).default([]),
      }),
    });
    let renderedInput;
    const workflow = smithers((ctx) => {
      renderedInput = ctx.input;
      return <Workflow name="preview-partial" />;
    });
    try {
      await Effect.runPromise(
        renderFrame(
          workflow,
          {
            runId: "preview-partial",
            iteration: 0,
            input: {},
            outputs: {},
          },
          { allowMissingRequiredInput: true },
        ),
      );
      expect(renderedInput).toEqual({ tickets: [] });
    } finally {
      cleanup();
    }
  });
  test("reports INVALID_INPUT for malformed preview input", async () => {
    const { smithers, cleanup } = createTestSmithers({
      input: z.object({ tickets: z.array(z.string()).default([]) }),
    });
    const workflow = smithers(() => <Workflow name="preview-invalid" />);
    try {
      const error = await Effect.runPromise(
        Effect.flip(
          renderFrame(workflow, {
            runId: "preview-invalid",
            iteration: 0,
            input: { tickets: "not-an-array" },
            outputs: {},
          }),
        ),
      );
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.details.issues).toBeArray();
    } finally {
      cleanup();
    }
  });
  test("renders object input when no input schema exists", async () => {
    const { smithers, cleanup } = createTestSmithers({});
    let renderedInput;
    const workflow = smithers((ctx) => {
      renderedInput = ctx.input;
      return <Workflow name="preview-no-schema" />;
    });
    try {
      await Effect.runPromise(
        renderFrame(workflow, {
          runId: "preview-no-schema",
          iteration: 0,
          input: { value: 1 },
          outputs: {},
        }),
      );
      expect(renderedInput).toEqual({ value: 1 });
    } finally {
      cleanup();
    }
  });
});

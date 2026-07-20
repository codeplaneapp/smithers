/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Workflow, Task, runWorkflow } from "smithers-orchestrator";
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
            const workflow = smithers((ctx) => (<Workflow name="input-defaults">
        <Task id="t" output={outputs.out}>
          {{
              lruLimit: ctx.input.lruLimit,
              sliceLength: [1, 2, 3].slice(0, ctx.input.lruLimit).length,
              label: ctx.input.label,
          }}
        </Task>
      </Workflow>));

            const r = await Effect.runPromise(runWorkflow(workflow, { input: {} }));

            expect(r.status).toBe("finished");
            const rows = db.select().from(tables.out).all();
            expect(rows[0]).toMatchObject({
                lruLimit: 2,
                sliceLength: 2,
                label: "defaulted",
            });
        }
        finally {
            cleanup();
        }
    });
});

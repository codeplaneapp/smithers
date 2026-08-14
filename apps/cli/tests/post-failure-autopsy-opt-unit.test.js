import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createSmithers } from "smthrs";

// The per-workflow `postFailureAutopsy` opt is a SmithersWorkflowOptions field
// consumed CLI-side in `up`'s finishRun (which only has `workflow.opts`, not the
// rendered graph). It rides the `smithers(build, opts)` second argument the same
// way `cache`/`alertPolicy`/`output` do, landing on `workflow.opts`.

describe("workflow-level postFailureAutopsy opt", () => {
  test("smithers(build, { postFailureAutopsy: false }) lands opts.postFailureAutopsy === false", () => {
    const { smithers } = createSmithers({ result: z.object({ ok: z.boolean() }) });
    const workflow = smithers(() => null, { postFailureAutopsy: false });
    expect(workflow.opts.postFailureAutopsy).toBe(false);
  });

  test("the opt defaults to absent (autopsy on) when not set", () => {
    const { smithers } = createSmithers({ result: z.object({ ok: z.boolean() }) });
    const workflow = smithers(() => null);
    expect(workflow.opts.postFailureAutopsy).toBeUndefined();
  });
});

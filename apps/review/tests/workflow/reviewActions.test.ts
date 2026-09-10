import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Flow, Interpreter } from "@smthrs/flow";
import { Effect, Layer, Schema } from "effect";
import { ApplyVerdicts, RenderWalkthrough } from "../../src/workflow/reviewActions.ts";
import { ReviewRunOutput } from "../../src/workflow/openCodeReview.ts";
import { layerMemory } from "../../src/workflow/reviewLayer.ts";
import { scriptedSeats } from "./scriptedSeats.ts";

const RenderTest = Flow.make("test/RenderWalkthrough", {
  payload: RenderWalkthrough.payloadSchema, success: RenderWalkthrough.successSchema,
  body: (payload) => RenderWalkthrough.call(payload),
});
const VerifyTest = Flow.make("test/ApplyVerdicts", {
  payload: ApplyVerdicts.payloadSchema, success: ApplyVerdicts.successSchema,
  body: (payload) => ApplyVerdicts.call(payload),
});
const testLayer = () => Layer.merge(Interpreter.layer(RenderTest), Interpreter.layer(VerifyTest)).pipe(
  Layer.provideMerge(layerMemory(scriptedSeats(() => undefined))),
);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const review = Schema.decodeUnknownSync(ReviewRunOutput)({ status: "success", ok: true });

async function render(out: string, outcome: unknown = review) {
  return Effect.runPromise(RenderTest.execute(Schema.decodeUnknownSync(RenderWalkthrough.payloadSchema)({
    input: { repo: dirname(out), out },
    target: { repoDir: dirname(out), mode: "workspace", ref: "workspace" },
    changes: { files: [{ path: "a.ts", status: "modified", diff: "", reviewed: true }] },
    review: outcome, story: null, quiz: null,
  }), { executionId: `render-${crypto.randomUUID()}` }).pipe(
    Effect.provide(testLayer()),
  ));
}

function outputPath() {
  const dir = fs.mkdtempSync(join(tmpdir(), "review-artifact-"));
  dirs.push(dir);
  return join(dir, "walkthrough.html");
}

test("verifier failure promotes success and preserves findings", async () => {
  const result = await Effect.runPromise(VerifyTest.execute({ review, verdicts: null }, {
    executionId: `verify-${crypto.randomUUID()}`,
  }).pipe(Effect.provide(testLayer())));
  expect(result.status).toBe("completed_with_warnings");
  expect(result.comments).toEqual(review.comments);
  expect(result.warnings).toContainEqual(expect.objectContaining({ type: "verifier_error", message: expect.stringContaining("unverified") }));
});

test("render action carries failed review diagnostics into HTML", async () => {
  const out = outputPath();
  await render(out, { ...review, status: "failed", ok: false, warnings: [{ file: "a.ts", type: "subtask_error", message: "seat timed out" }] });
  const html = fs.readFileSync(out, "utf8");
  expect(html).toContain("Review failed");
  expect(html).toContain("seat timed out");
  expect(html).toContain("not reviewed");
  expect(html).not.toContain('findings <strong>0</strong>');
});

test("each render retains its own artifact when the user-facing output is replaced", async () => {
  const out = outputPath();
  const first = await render(out);
  const firstHtml = fs.readFileSync(out, "utf8");
  const second = await render(out, { ...review, status: "failed", ok: false });
  const artifact = first.walkthrough.artifactPath;
  expect(artifact).toBeString();
  expect(artifact).not.toBe(out);
  expect(artifact).not.toBe(second.walkthrough.artifactPath);
  expect(fs.readFileSync(artifact, "utf8")).toBe(firstHtml);
  expect(fs.readFileSync(out, "utf8")).not.toBe(firstHtml);
});

test.each(["artifact", "output"])("a partial %s write leaves the previous user-facing artifact intact", async (stage) => {
  const out = outputPath();
  fs.writeFileSync(out, "previous complete artifact");
  const original = fs.writeFileSync;
  let injected = false;
  const write = spyOn(fs, "writeFileSync").mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
    // Inject a write failure after truncation at either atomic handoff.
    if ((dirname(String(args[0])) === dirname(out)) === (stage === "output")) {
      injected = true;
      original(args[0], "partial");
      throw new Error("disk full");
    }
    return original(...args);
  });
  try {
    await expect(render(out)).rejects.toThrow("disk full");
  } finally { write.mockRestore(); }
  expect(injected).toBe(true);
  expect(fs.readFileSync(out, "utf8")).toBe("previous complete artifact");
  expect(fs.readdirSync(dirname(out), { recursive: true }).filter((name) => String(name).endsWith(".tmp"))).toEqual([]);
});


test.each(["failed", "completed_with_errors", "completed_with_warnings"] as const)("verifier failure preserves %s status", async (status) => {
  const result = await Effect.runPromise(VerifyTest.execute({
    review: { ...review, status, ok: status !== "failed" }, verdicts: null, failure: "provider refused",
  }, { executionId: `verify-${crypto.randomUUID()}` }).pipe(Effect.provide(testLayer())));
  expect(result.status).toBe(status);
  expect(result.warnings[0]?.message).toContain("review-verify: provider refused");
});

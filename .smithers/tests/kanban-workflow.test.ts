import { describe, expect, test } from "bun:test";
import { buildFeedback } from "../workflows/kanban.tsx";
import { ValidationLoop } from "../components/ValidationLoop";

type Row = Record<string, unknown>;

function fakeCtx(outputs: { validate?: Row[]; review?: Row[] }) {
  return { outputs: { validate: outputs.validate ?? [], review: outputs.review ?? [] } };
}

const slug = "bench__t01";
const validateRow = (iteration: number, allPassed: boolean, failingSummary: string | null = null): Row => ({
  nodeId: `${slug}:validate`,
  iteration,
  allPassed,
  failingSummary,
  summary: "s",
});
const reviewRow = (iteration: number, approved: boolean, index = 0): Row => ({
  nodeId: `${slug}:review:${index}`,
  iteration,
  approved,
  reviewer: `r${index}`,
  feedback: approved ? "lgtm" : "needs work",
  issues: [],
});

describe("kanban buildFeedback", () => {
  test("no validate output yet: not done, no feedback, validation not passed", () => {
    const out = buildFeedback(fakeCtx({}), slug);
    expect(out).toEqual({ feedback: null, done: false, validationPassed: false });
  });

  test("failed validate: not done, feedback carries the failing summary", () => {
    const out = buildFeedback(fakeCtx({ validate: [validateRow(0, false, "tests are red")] }), slug);
    expect(out.done).toBe(false);
    expect(out.validationPassed).toBe(false);
    expect(out.feedback).toContain("VALIDATION FAILED");
    expect(out.feedback).toContain("tests are red");
  });

  test("validate passed + same-iteration approval: done", () => {
    const out = buildFeedback(fakeCtx({ validate: [validateRow(0, true)], review: [reviewRow(0, true)] }), slug);
    expect(out.done).toBe(true);
    expect(out.validationPassed).toBe(true);
  });

  test("stale approval does not green-light re-implemented code", () => {
    // Round 0: validate failed but a reviewer approved. Round 1: validate
    // passed, no round-1 review yet. The old gate leaked the round-0 approval.
    const out = buildFeedback(
      fakeCtx({
        validate: [validateRow(0, false, "broken"), validateRow(1, true)],
        review: [reviewRow(0, true)],
      }),
      slug,
    );
    expect(out.validationPassed).toBe(true);
    expect(out.done).toBe(false);
  });

  test("re-review of the latest round completes the gate", () => {
    const out = buildFeedback(
      fakeCtx({
        validate: [validateRow(0, false, "broken"), validateRow(1, true)],
        review: [reviewRow(0, true), reviewRow(1, true)],
      }),
      slug,
    );
    expect(out.done).toBe(true);
  });

  test("rejections from earlier rounds are not re-fed as feedback", () => {
    const out = buildFeedback(
      fakeCtx({
        validate: [validateRow(0, true), validateRow(1, true)],
        review: [reviewRow(0, false), reviewRow(1, false, 1)],
      }),
      slug,
    );
    expect(out.done).toBe(false);
    expect(out.feedback).toContain("needs work");
    // exactly one rejection block: the current round's, not both rounds'
    expect(out.feedback?.match(/REVIEWER REJECTED/g)?.length).toBe(1);
  });

  test("reviews for other tickets are ignored", () => {
    const out = buildFeedback(
      fakeCtx({
        validate: [validateRow(0, true)],
        review: [{ ...reviewRow(0, true), nodeId: "bench__t02:review:0" }],
      }),
      slug,
    );
    expect(out.done).toBe(false);
  });
});

function sequenceChildren(loopElement: any): unknown[] {
  const sequence = loopElement.props.children;
  const children = sequence.props.children;
  return (Array.isArray(children) ? children : [children]).filter(Boolean);
}

describe("ValidationLoop reviewWhen", () => {
  const base = {
    idPrefix: "t",
    prompt: "do it",
    implementAgents: [] as never[],
    reviewAgents: [] as never[],
  };

  test("default mounts implement, validate, review", () => {
    const children = sequenceChildren(ValidationLoop(base as never));
    expect(children.length).toBe(3);
  });

  test("reviewWhen=false unmounts only the review step", () => {
    const children = sequenceChildren(ValidationLoop({ ...base, reviewWhen: false } as never));
    expect(children.length).toBe(2);
    for (const child of children as Array<{ props: { id?: string } }>) {
      expect(child.props.id?.includes(":review")).toBe(false);
    }
  });

  test("reviewWhen=true keeps the review step with a stable node id", () => {
    const children = sequenceChildren(ValidationLoop({ ...base, reviewWhen: true } as never)) as Array<{
      props: { idPrefix?: string; id?: string };
    }>;
    expect(children.length).toBe(3);
    const review = children[2];
    expect(review.props.idPrefix ?? review.props.id).toContain("t:review");
  });
});

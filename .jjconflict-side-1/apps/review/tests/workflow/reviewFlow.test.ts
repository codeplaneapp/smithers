import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { Review } from "../../src/workflow/reviewFlow.ts";
import { layerMemory } from "../../src/workflow/reviewLayer.ts";
import { scriptedSeats } from "./scriptedSeats.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  }
});

/** A repository whose working tree changes `count` files against its first commit. */
function tempRepo(count: number): string {
  const dir = mkdtempSync(join(tmpdir(), "review-flow-"));
  tempDirs.push(dir);
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run(["init"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test User"]);
  run(["config", "commit.gpgsign", "false"]);
  mkdirSync(dirname(join(dir, "src/a.ts")), { recursive: true });
  for (let index = 0; index < count; index += 1) {
    writeFileSync(join(dir, `src/file${index}.ts`), `export const value${index} = ${index};\n`);
  }
  run(["add", "."]);
  run(["commit", "-m", "base"]);
  for (let index = 0; index < count; index += 1) {
    writeFileSync(
      join(dir, `src/file${index}.ts`),
      `export const value${index} = ${index};\nexport const next${index} = ${index + 1};\n`,
    );
  }
  return dir;
}

const finding = (path: string) => ({
  path,
  content: "The new binding shadows the old one.",
  severity: "major",
  category: "correctness",
  confidence: "confirmed",
  startLine: 2,
  endLine: 2,
  existingCode: "",
  suggestionCode: "",
  thinking: "",
});

/** The four answers the four seats give, keyed off what each was asked. */
function answerFor(options: { findingsFor?: (path: string) => boolean; refuse?: ReadonlySet<string> } = {}) {
  const refuse = options.refuse ?? new Set<string>();
  return (ask: string): unknown => {
    if (ask.includes("adjudicate code-review findings")) {
      if (refuse.has("verify")) return undefined;
      return { verdicts: [{ index: 0, verdict: "keep", reason: "the diff shows it" }] };
    }
    if (ask.includes("explain a change set to a reader")) {
      if (refuse.has("narrate")) return undefined;
      return {
        headline: "Two bindings",
        synopsis: "Each file gains a second export.",
        chapters: [
          {
            title: "The change",
            // A diff block naming a real changed file: without one,
            // `normalizeStory` rejects the story and falls back, which is the
            // 0.x invariant this fixture has to satisfy to be used at all.
            blocks: [
              { kind: "prose", text: "Each file gains one export." },
              { kind: "diff", path: "src/file0.ts", intro: "The new export." },
            ],
          },
        ],
      };
    }
    if (ask.includes("comprehension questions")) {
      if (refuse.has("quiz")) return undefined;
      return { impact: { level: "low", reasons: [] }, questions: [] };
    }
    if (refuse.has("review")) return undefined;
    const path = /Review the following file: (\S+)/.exec(ask)?.[1] ??
      /(src\/file\d+\.ts)/.exec(ask)?.[1] ??
      "";
    const wanted = options.findingsFor === undefined || options.findingsFor(path);
    return { status: "success", message: "", summary: null, comments: wanted ? [finding(path)] : [], warnings: [] };
  };
}

type ReviewOverrides = Partial<Parameters<typeof Review.execute>[0]>;

const runReview = (
  repo: string,
  input: ReviewOverrides,
  answer: (ask: string) => unknown,
) =>
  Effect.runPromise(
    Review.execute({ repo, ...input } as Parameters<typeof Review.execute>[0], {
      executionId: `review-test-${Math.random()}`,
    }).pipe(
      Effect.provide(layerMemory(scriptedSeats(answer))),
      Effect.orDie,
    ),
  );

describe("the review flow", () => {
  test("fans out over every changed file and reports one finding per file", async () => {
    const repo = tempRepo(3);
    const out = join(repo, "walkthrough.html");
    const result = await runReview(
      repo,
      { narrate: false, quiz: "off", verify: false, out },
      answerFor(),
    );

    expect(result.review.status).toBe("success");
    expect(result.review.comments).toHaveLength(3);
    expect(result.review.comments.map((comment) => comment.path).sort()).toEqual([
      "src/file0.ts",
      "src/file1.ts",
      "src/file2.ts",
    ]);
    expect(result.walkthrough.findings).toBe(3);
    expect(readFileSync(out, "utf8")).toContain("<!doctype html>");
  }, 120_000);

  // KNOWN GAP, pinned deliberately: `--concurrency` does not bound the calls.
  //
  // The old assertion here was `peak > 0`, which the scripted model satisfied
  // by answering inside the tick it was called in; it would have held for any
  // width at all. Held open, the real width shows: all five files are asked at
  // once under `concurrency: 2`.
  //
  // The batch shape is not what fails. `packages/smithers/flows/flow/src/Interpreter.ts`
  // settles every dependency of a node concurrently, with
  // `concurrency: "unbounded"`, before it runs the node, so a batch chained
  // onto its predecessor with `Node.andThen` starts alongside it just as the
  // `Node.all` pairing in `ReviewFiles` does (checked both ways against this
  // test). Ordering continuations is the plan contract's to change and
  // `@smthrs/flow` is not this app's to edit, so the suite pins what ships.
  // When the engine orders them, both assertions below become 2.
  test("fans out over every file, currently without honouring the bound", async () => {
    const repo = tempRepo(5);
    let inFlight = 0;
    let peak = 0;
    let started = 0;
    // Every call parks here until the test lets it go, so calls that really are
    // simultaneous are all in flight at once and `peak` is the true width. A
    // synchronous answer settles in its own tick and reports a peak of 1 no
    // matter how wide the fan-out is, which is why the old assertion here
    // (`peak > 0`) held whatever the engine did.
    const release: (() => void)[] = [];
    /** Resolves once at least `count` calls have started. */
    const reached = (count: number) =>
      new Promise<void>((resolve) => {
        const poll = () => (started >= count ? resolve() : setTimeout(poll, 5));
        poll();
      });

    const pending = runReview(
      repo,
      { narrate: false, quiz: "off", verify: false, concurrency: 2, out: join(repo, "w.html") },
      async (ask) => {
        inFlight += 1;
        started += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => release.push(resolve));
        inFlight -= 1;
        return answerFor()(ask);
      },
    );

    await reached(2);
    await new Promise((resolve) => setTimeout(resolve, 250));
    // With the bound enforced these would both be 2. All five files are asked
    // at once instead, which is the gap: a wide PR makes one provider call per
    // changed file simultaneously, whatever `--concurrency` says.
    expect(started).toBe(5);
    expect(peak).toBe(5);

    for (const next of release.splice(0)) next();
    const result = await pending;
    // What does hold: every file is reviewed, and every batch merges, so the
    // findings are complete however the calls were scheduled.
    expect(result.review.comments).toHaveLength(5);
    expect(result.review.comments.map((comment) => comment.path).sort()).toEqual([
      "src/file0.ts",
      "src/file1.ts",
      "src/file2.ts",
      "src/file3.ts",
      "src/file4.ts",
    ]);
  }, 120_000);

  test("a file review that fails becomes a warning, not a dead run", async () => {
    const repo = tempRepo(1);
    const result = await runReview(
      repo,
      { narrate: false, quiz: "off", verify: false, out: join(repo, "w.html") },
      answerFor({ refuse: new Set(["review"]) }),
    );

    expect(result.review.status).toBe("failed");
    expect(result.review.warnings.some((warning) => warning.type === "subtask_error")).toBe(true);
    expect(result.walkthrough.path).toBe(join(repo, "w.html"));
  }, 120_000);

  test("verification runs on the findings and its verdicts reach the walkthrough", async () => {
    const repo = tempRepo(1);
    const result = await runReview(
      repo,
      { narrate: false, quiz: "off", verify: true, out: join(repo, "w.html") },
      (ask) =>
        ask.includes("adjudicate code-review findings")
          ? { verdicts: [{ index: 0, verdict: "drop", reason: "the diff refutes it" }] }
          : answerFor()(ask),
    );

    expect(result.review.comments).toHaveLength(0);
    expect(result.review.warnings.some((warning) => warning.type === "verifier_dropped")).toBe(true);
    expect(result.review.message).toContain("Verification dropped 1 finding");
  }, 120_000);

  test("a verifier that fails leaves the findings unverified rather than failing the review", async () => {
    const repo = tempRepo(1);
    const result = await runReview(
      repo,
      { narrate: false, quiz: "off", verify: true, out: join(repo, "w.html") },
      answerFor({ refuse: new Set(["verify"]) }),
    );

    expect(result.review.comments).toHaveLength(1);
    expect(result.review.warnings.some((warning) => warning.type === "verifier_error")).toBe(true);
  }, 120_000);

  test("the narrator's story reaches the rendered walkthrough", async () => {
    const repo = tempRepo(1);
    const out = join(repo, "w.html");
    const result = await runReview(repo, { narrate: true, quiz: "off", verify: false, out }, answerFor());

    expect(result.story.headline).toBe("Two bindings");
    expect(result.walkthrough.chapters).toBeGreaterThan(0);
    expect(readFileSync(out, "utf8")).toContain("Two bindings");
  }, 120_000);

  test("a narrator that fails falls back to the deterministic story", async () => {
    const repo = tempRepo(1);
    const result = await runReview(
      repo,
      { narrate: true, quiz: "off", verify: false, out: join(repo, "w.html") },
      answerFor({ refuse: new Set(["narrate"]) }),
    );

    expect(result.review.comments).toHaveLength(1);
    expect(result.story.chapters.length).toBeGreaterThan(0);
    expect(result.story.headline).not.toBe("Two bindings");
  }, 120_000);

  test("--no-review skips the seats and reports the skipped status", async () => {
    const repo = tempRepo(2);
    const result = await runReview(
      repo,
      { runReview: false, narrate: false, quiz: "off", verify: false, out: join(repo, "w.html") },
      () => {
        throw new Error("no seat should be asked for a --no-review run");
      },
    );

    expect(result.review.status).toBe("skipped");
    expect(result.review.comments).toHaveLength(0);
    expect(result.walkthrough.files).toBe(2);
  }, 120_000);

  test("the quiz runs when the input demands it and lands in the result", async () => {
    const repo = tempRepo(1);
    const result = await runReview(
      repo,
      { narrate: false, quiz: "on", verify: false, out: join(repo, "w.html") },
      (ask) =>
        ask.includes("comprehension questions")
          ? {
            impact: { level: "low", reasons: [] },
            questions: [
              {
                question: "What does the change add?",
                options: ["A second export", "A deletion"],
                correctIndex: 0,
                explanation: "The diff adds one export.",
                path: "src/file0.ts",
              },
            ],
          }
          : answerFor()(ask),
    );

    expect(result.quiz?.questions).toHaveLength(1);
    expect(result.walkthrough.questions).toBe(1);
  }, 120_000);
});

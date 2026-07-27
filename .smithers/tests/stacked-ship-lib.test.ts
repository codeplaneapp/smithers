import { describe, expect, test } from "bun:test";
import {
  artifactFileName,
  baseBookmarkFor,
  bookmarkFor,
  classifyDecision,
  cloneCommands,
  commitMessageCheck,
  countLogLines,
  decisionNote,
  hygieneVerdict,
  lanePhase,
  laneWorkspaceCommands,
  parentRevFor,
  parseStackPlan,
  parseSummaryPaths,
  pathAllowed,
  planFromRow,
  reportsDirFor,
  stackKeyFromRunId,
  workspaceNameFor,
} from "../lib/stackedShip";
import {
  fallbackStory,
  normalizeStory,
  renderPrArtifactHtml,
  renderStackIndexHtml,
  splitUnifiedDiff,
  stackStorySchema,
} from "../lib/stackArtifact";

const ENTRY = {
  slug: "studio-scaffold",
  title: "Scaffold the studio app shell",
  goal: "Create apps/studio with the electrobun config, a booting React webview, and the preflight service skeleton.",
  scopes: ["apps/studio"],
  checks: ["bun test tests/preflight.test.ts"],
  storyHint: "",
};

function makePlan(slugs: string[]) {
  return {
    missionTitle: "Smithers Studio",
    assembleChecks: ["pnpm -C apps/studio test"],
    entries: slugs.map((slug) => ({ ...ENTRY, slug })),
  };
}

describe("parseStackPlan", () => {
  test("accepts an object and preserves order", () => {
    const plan = parseStackPlan(makePlan(["one-a", "two-b", "three-c"]), 10);
    expect(plan.entries.map((entry) => entry.slug)).toEqual(["one-a", "two-b", "three-c"]);
    expect(plan.missionTitle).toBe("Smithers Studio");
    expect(plan.assembleChecks).toEqual(["pnpm -C apps/studio test"]);
  });

  test("accepts a JSON string", () => {
    const plan = parseStackPlan(JSON.stringify(makePlan(["only-pr"])), 5);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].slug).toBe("only-pr");
  });

  test("clamps to maxPrs", () => {
    const plan = parseStackPlan(makePlan(["aa", "bb", "cc", "dd"]), 2);
    expect(plan.entries.map((entry) => entry.slug)).toEqual(["aa", "bb"]);
  });

  test("throws on duplicate slugs", () => {
    expect(() => parseStackPlan(makePlan(["same", "same"]), 10)).toThrow("duplicate plan slug: same");
  });

  test("throws on empty input, bad slugs, and missing fields", () => {
    expect(() => parseStackPlan("", 5)).toThrow("stack plan is empty");
    expect(() => parseStackPlan("not json", 5)).toThrow();
    expect(() => parseStackPlan({ ...makePlan(["Bad_Slug"]) }, 5)).toThrow();
    expect(() => parseStackPlan({ missionTitle: "x", entries: [] }, 5)).toThrow();
    expect(() =>
      parseStackPlan({ missionTitle: "Mission", entries: [{ ...ENTRY, slug: "ok-slug", scopes: [] }] }, 5),
    ).toThrow();
  });
});

describe("planFromRow", () => {
  test("reads a row-wrapped record with JSON-stringified arrays", () => {
    const source = makePlan(["from-row"]);
    const row = {
      row: {
        missionTitle: source.missionTitle,
        assembleChecks: JSON.stringify(source.assembleChecks),
        entries: JSON.stringify(source.entries),
      },
    };
    const plan = planFromRow(row, 10);
    expect(plan?.entries[0].slug).toBe("from-row");
    expect(plan?.assembleChecks).toEqual(source.assembleChecks);
  });

  test("reads real arrays and clamps", () => {
    const plan = planFromRow(makePlan(["kk-1", "kk-2", "kk-3"]), 2);
    expect(plan?.entries).toHaveLength(2);
  });

  test("returns null on garbage", () => {
    expect(planFromRow(null, 5)).toBeNull();
    expect(planFromRow("nope", 5)).toBeNull();
    expect(planFromRow({ missionTitle: "x" }, 5)).toBeNull();
    expect(planFromRow({ missionTitle: "Mission", entries: "not-json" }, 5)).toBeNull();
  });
});

describe("naming", () => {
  test("stackKeyFromRunId sanitizes and never returns empty", () => {
    expect(stackKeyFromRunId("run 1234/abc!!")).toBe("run-1234-abc-");
    expect(stackKeyFromRunId("!!!")).toBe("-");
    expect(stackKeyFromRunId("")).toBe("run");
    expect(stackKeyFromRunId("a".repeat(80))).toHaveLength(40);
  });

  test("bookmark, base, and workspace names", () => {
    expect(bookmarkFor("k1", "pr-one")).toBe("stack/k1/pr-one");
    expect(baseBookmarkFor("k1")).toBe("stack/k1/base");
    expect(workspaceNameFor("pr-one")).toBe("pr-pr-one");
  });

  test("parentRevFor walks the stack", () => {
    const entries = makePlan(["first-pr", "second-pr"]).entries;
    expect(parentRevFor("k1", entries, 0)).toBe("stack/k1/base");
    expect(parentRevFor("k1", entries, 1)).toBe("stack/k1/first-pr");
    expect(parentRevFor("k1", entries, -3)).toBe("stack/k1/base");
  });
});

describe("commitMessageCheck", () => {
  test("accepts the repo commit style", () => {
    expect(commitMessageCheck("🐛 fix(engine): stamp CLI-launched runs public").ok).toBe(true);
    expect(commitMessageCheck("✨ feat(studio): scaffold the electrobun shell\n\nbody").ok).toBe(true);
  });

  test("rejects empties, missing types, plain-ascii lead tokens, short subjects", () => {
    expect(commitMessageCheck("").ok).toBe(false);
    expect(commitMessageCheck("   \n").ok).toBe(false);
    expect(commitMessageCheck("fix: no scope here at all").ok).toBe(false);
    expect(commitMessageCheck("wip fix(engine): something real").ok).toBe(false);
    expect(commitMessageCheck("🐛 fix(engine): short").ok).toBe(false);
    expect(commitMessageCheck("🐛 unknown(engine): a real subject here").ok).toBe(false);
  });
});

describe("pathAllowed", () => {
  test("matches exact files, directory prefixes, and globs", () => {
    expect(pathAllowed("apps/studio/src/main.ts", ["apps/studio"])).toBe(true);
    expect(pathAllowed("apps/studio/src/main.ts", ["apps/studio/**"])).toBe(true);
    expect(pathAllowed("apps/studio", ["apps/studio"])).toBe(true);
    expect(pathAllowed("./apps/studio/x.ts", ["apps/studio"])).toBe(true);
    expect(pathAllowed("anything/at/all.ts", ["**"])).toBe(true);
    expect(pathAllowed("apps/studioX/main.ts", ["apps/studio"])).toBe(false);
    expect(pathAllowed("packages/ui/src/x.ts", ["apps/studio", "docs"])).toBe(false);
  });
});

describe("hygieneVerdict", () => {
  const CLEAN = {
    changeCount: 1,
    description: "✨ feat(studio): scaffold the electrobun shell",
    changedPaths: ["apps/studio/package.json"],
    scopes: ["apps/studio"],
    conflictedCount: 0,
    checks: [{ command: "bun test", exitCode: 0, tail: "" }],
  };

  test("clean input passes with empty feedback", () => {
    const verdict = hygieneVerdict(CLEAN);
    expect(verdict).toEqual({ ok: true, reasons: [], feedback: "" });
  });

  test("each violation produces its reason", () => {
    expect(hygieneVerdict({ ...CLEAN, changeCount: 0 }).reasons[0]).toContain("exactly one jj change");
    expect(hygieneVerdict({ ...CLEAN, changeCount: 3 }).reasons[0]).toContain("jj squash");
    expect(hygieneVerdict({ ...CLEAN, description: "bad" }).reasons[0]).toContain("does not match");
    expect(hygieneVerdict({ ...CLEAN, changedPaths: [] }).reasons[0]).toContain("diff against the parent is empty");
    expect(hygieneVerdict({ ...CLEAN, changedPaths: ["packages/db/src/x.js"] }).reasons[0]).toContain(
      "paths outside the lane scopes",
    );
    expect(hygieneVerdict({ ...CLEAN, conflictedCount: 2 }).reasons[0]).toContain("2 descendant change(s) are conflicted");
    const failing = hygieneVerdict({ ...CLEAN, checks: [{ command: "bun test", exitCode: 1, tail: "boom" }] });
    expect(failing.reasons[0]).toContain("check failed (exit 1)");
    expect(failing.reasons[0]).toContain("boom");
  });

  test("aggregates every reason into feedback", () => {
    const verdict = hygieneVerdict({
      ...CLEAN,
      changeCount: 2,
      description: "junk",
      changedPaths: ["outside/scope.ts"],
      conflictedCount: 1,
      checks: [{ command: "x", exitCode: 7, tail: "t" }],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toHaveLength(5);
    expect(verdict.feedback).toContain("HYGIENE FAILURES:");
    for (const reason of verdict.reasons) expect(verdict.feedback).toContain(reason.slice(0, 40));
  });

  test("truncates the out-of-scope list at 12 paths", () => {
    const paths = Array.from({ length: 20 }, (_, index) => "outside/file-" + index + ".ts");
    const verdict = hygieneVerdict({ ...CLEAN, changedPaths: paths });
    expect(verdict.reasons[0]).toContain("(+8 more)");
  });
});

describe("classifyDecision + decisionNote", () => {
  test("recognizes every stored boolean encoding", () => {
    for (const approved of [true, 1, "1", "true"]) {
      expect(classifyDecision({ approved })).toBe("approved");
      expect(classifyDecision({ row: { approved } })).toBe("approved");
    }
    for (const approved of [false, 0, "0", "false"]) {
      expect(classifyDecision({ approved })).toBe("denied");
    }
    expect(classifyDecision(undefined)).toBe("pending");
    expect(classifyDecision(null)).toBe("pending");
    expect(classifyDecision({})).toBe("pending");
    expect(classifyDecision("string")).toBe("pending");
  });

  test("decisionNote reads note then reason", () => {
    expect(decisionNote({ note: "tighten tests" })).toBe("tighten tests");
    expect(decisionNote({ row: { reason: "because" } })).toBe("because");
    expect(decisionNote({})).toBe("");
    expect(decisionNote(undefined)).toBe("");
  });
});

describe("lanePhase", () => {
  const BASE = {
    hasWorkspace: true,
    hygieneOk: true,
    selfReviewApproved: true,
    decision: "pending" as const,
    buildExhausted: false,
    reviewExhausted: false,
  };
  test("covers every phase", () => {
    expect(lanePhase({ ...BASE, hasWorkspace: false })).toBe("pending");
    expect(lanePhase({ ...BASE, decision: "approved" })).toBe("approved");
    expect(lanePhase({ ...BASE, hygieneOk: false })).toBe("building");
    expect(lanePhase({ ...BASE, selfReviewApproved: false, buildExhausted: true })).toBe("blocked");
    expect(lanePhase({ ...BASE, reviewExhausted: true })).toBe("unapproved");
    expect(lanePhase(BASE)).toBe("reviewing");
  });
});

describe("command plans", () => {
  test("cloneCommands with and without an origin url", () => {
    expect(cloneCommands({ sourceRoot: "/src", originUrl: "git@github.com:o/r.git", destDir: "/dest" })).toEqual([
      ["git", "clone", "--no-hardlinks", "/src", "/dest"],
      ["git", "-C", "/dest", "remote", "set-url", "origin", "git@github.com:o/r.git"],
    ]);
    expect(cloneCommands({ sourceRoot: "/src", originUrl: "", destDir: "/dest" })).toEqual([
      ["git", "clone", "--no-hardlinks", "/src", "/dest"],
    ]);
  });

  test("laneWorkspaceCommands creates the workspace then pins the bookmark", () => {
    const steps = laneWorkspaceCommands({
      slug: "one",
      parentRev: "stack/k/base",
      bookmark: "stack/k/one",
      workspaceDir: "/ws/pr-one",
    });
    expect(steps).toEqual([
      {
        argv: ["jj", "workspace", "add", "--name", "pr-one", "--revision", "stack/k/base", "/ws/pr-one"],
        cwd: "root",
      },
      { argv: ["jj", "bookmark", "set", "stack/k/one", "-r", "@", "--allow-backwards"], cwd: "workspace" },
    ]);
  });
});

describe("jj output parsing", () => {
  test("countLogLines ignores blanks", () => {
    expect(countLogLines("")).toBe(0);
    expect(countLogLines("\n\n")).toBe(0);
    expect(countLogLines("abc\n")).toBe(1);
    expect(countLogLines("a\nb\n\nc\n")).toBe(3);
  });

  test("parseSummaryPaths handles statuses, renames, and dedupes", () => {
    const out = parseSummaryPaths(["M apps/studio/a.ts", "A apps/studio/b.ts", "D old.txt", "R from.ts -> to.ts", "", "junk line"].join("\n"));
    expect(out).toEqual(["apps/studio/a.ts", "apps/studio/b.ts", "old.txt", "from.ts", "to.ts"]);
    expect(parseSummaryPaths("M same.ts\nA same.ts")).toEqual(["same.ts"]);
    expect(parseSummaryPaths("")).toEqual([]);
  });
});

describe("artifact paths", () => {
  test("reportsDirFor and artifactFileName", () => {
    expect(reportsDirFor("/repo/", "key1")).toBe("/repo/.smithers/reports/stacked-ship/key1");
    expect(artifactFileName("slug", 3)).toBe("slug-r3.html");
    expect(artifactFileName("slug", -1)).toBe("slug-r0.html");
    expect(artifactFileName("slug", 2.9)).toBe("slug-r2.html");
  });
});

// ── stackArtifact ────────────────────────────────────────────────────────────

const STORY = {
  headline: "The studio shell now boots",
  synopsis: "This PR scaffolds the electrobun app so the webview boots a React shell with a preflight screen.",
  chapters: [
    {
      title: "The scaffold",
      prose: "Everything starts with the `apps/studio` package: config, entry, and dev scripts.",
      diffPaths: ["apps/studio/package.json", "hallucinated/nope.ts"],
    },
  ],
};

const DIFF = [
  "diff --git a/apps/studio/package.json b/apps/studio/package.json",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/apps/studio/package.json",
  "@@ -0,0 +1,2 @@",
  '+{ "name": "@smithers-orchestrator/studio",',
  '+  "private": true }',
  "diff --git a/apps/studio/src/main.ts b/apps/studio/src/main.ts",
  "--- a/apps/studio/src/main.ts",
  "+++ b/apps/studio/src/main.ts",
  "@@ -1,1 +1,2 @@",
  " export {};",
  "+console.log('boot');",
].join("\n");

describe("story schema + normalizeStory + fallbackStory", () => {
  test("valid stories pass and unknown diff paths are dropped", () => {
    const story = normalizeStory(STORY, ["apps/studio/package.json", "apps/studio/src/main.ts"]);
    expect(story?.headline).toBe(STORY.headline);
    expect(story?.chapters[0].diffPaths).toEqual(["apps/studio/package.json"]);
  });

  test("accepts JSON strings and stringified chapters", () => {
    expect(normalizeStory(JSON.stringify(STORY), ["apps/studio/package.json"])?.headline).toBe(STORY.headline);
    const stringifiedChapters = { ...STORY, chapters: JSON.stringify(STORY.chapters) };
    expect(normalizeStory(stringifiedChapters, ["apps/studio/package.json"])?.chapters).toHaveLength(1);
  });

  test("returns null on unusable stories", () => {
    expect(normalizeStory(null, [])).toBeNull();
    expect(normalizeStory("not json", [])).toBeNull();
    expect(normalizeStory({ headline: "short" }, [])).toBeNull();
    expect(normalizeStory({ ...STORY, chapters: "broken json" }, [])).toBeNull();
    expect(normalizeStory({ ...STORY, chapters: [] }, [])).toBeNull();
  });

  test("fallbackStory always validates against the schema", () => {
    const withFiles = fallbackStory({ slug: "s1", title: "A perfectly good title", changedPaths: ["a.ts", "b.ts"] });
    expect(stackStorySchema.safeParse(withFiles).success).toBe(true);
    expect(withFiles.chapters[0].diffPaths).toEqual(["a.ts", "b.ts"]);
    const empty = fallbackStory({ slug: "s1", title: "A perfectly good title", changedPaths: [] });
    expect(stackStorySchema.safeParse(empty).success).toBe(true);
    expect(empty.chapters[0].prose).toContain("diff is empty");
  });
});

describe("splitUnifiedDiff", () => {
  test("splits files and extracts paths", () => {
    const files = splitUnifiedDiff(DIFF);
    expect(files.map((file) => file.path)).toEqual(["apps/studio/package.json", "apps/studio/src/main.ts"]);
    expect(files[0].text).toContain("new file mode");
    expect(files[1].text).toContain("console.log");
  });

  test("falls back to --- a/ then the diff header for deletions", () => {
    const deletion = ["diff --git a/gone.ts b/gone.ts", "--- a/gone.ts", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-x"].join("\n");
    expect(splitUnifiedDiff(deletion)[0].path).toBe("gone.ts");
    const headerOnly = "diff --git a/only.ts b/only.ts";
    expect(splitUnifiedDiff(headerOnly)[0].path).toBe("only.ts");
  });

  test("empty input yields no files", () => {
    expect(splitUnifiedDiff("")).toEqual([]);
    expect(splitUnifiedDiff("random text\nwithout diffs")).toEqual([]);
  });
});

describe("renderPrArtifactHtml", () => {
  const BASE_OPTIONS = {
    missionTitle: "Smithers Studio",
    stackKey: "key1",
    slug: "studio-scaffold",
    title: "Scaffold the studio app shell",
    revision: 1,
    story: STORY,
    diffText: DIFF,
    hygiene: { ok: true, reasons: [] as string[] },
    checks: [],
    approvalState: "pending",
    generatedAt: "2026-07-27T00:00:00Z",
    pierre: null,
  };

  test("renders a self-contained document with story, kpis, and DiffHunks fallback", async () => {
    const html = await renderPrArtifactHtml(BASE_OPTIONS);
    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain("<title>studio-scaffold r1 · Smithers Studio</title>");
    expect(html).toContain(STORY.headline);
    expect(html).toContain("The scaffold");
    expect(html).toContain("apps/studio/src/main.ts");
    // DiffHunks output (design-system classes), since pierre is disabled.
    expect(html).toContain("sui-");
    // Unreferenced files land in the trailing section.
    expect(html).toContain("Everything else");
    // Styles from the shared UI library are inlined.
    expect(html).toContain("<style");
  });

  test("failing hygiene renders the reasons list", async () => {
    const html = await renderPrArtifactHtml({
      ...BASE_OPTIONS,
      hygiene: { ok: false, reasons: ["the diff against the parent is empty"] },
    });
    expect(html).toContain("Hygiene failures");
    expect(html).toContain("the diff against the parent is empty");
    expect(html).toContain("failing");
  });

  test("escapes hostile story content", async () => {
    const hostile = {
      ...STORY,
      headline: '<script>alert("xss")</script> a headline',
      synopsis: STORY.synopsis,
    };
    const html = await renderPrArtifactHtml({ ...BASE_OPTIONS, story: hostile });
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");
  });

  test("uses injected pierre renderers and hoists styles once", async () => {
    let calls = 0;
    const pierre = {
      render: async () => {
        calls += 1;
        return "<style>PIERRE_STYLE</style><div>PIERRE_BODY_" + calls + "</div>";
      },
      extract: (html: string) => {
        const bodyStart = html.indexOf("</style>") + "</style>".length;
        return { sprite: "", styles: [html.slice(0, bodyStart)], body: html.slice(bodyStart) };
      },
    };
    const html = await renderPrArtifactHtml({ ...BASE_OPTIONS, pierre });
    expect(calls).toBe(2);
    expect(html).toContain('class="pierre-diff"');
    expect(html).toContain("PIERRE_BODY_1");
    expect(html).toContain("PIERRE_BODY_2");
    expect(html.split("PIERRE_STYLE")).toHaveLength(2);
  });

  test("a crashing pierre renderer degrades to DiffHunks", async () => {
    const pierre = {
      render: async () => {
        throw new Error("pierre exploded");
      },
      extract: () => ({ sprite: "", styles: [], body: "" }),
    };
    const html = await renderPrArtifactHtml({ ...BASE_OPTIONS, pierre });
    expect(html).toContain("sui-");
    expect(html).toContain(STORY.headline);
  });
});

describe("renderStackIndexHtml", () => {
  test("renders the ladder with artifact links", () => {
    const html = renderStackIndexHtml({
      missionTitle: "Smithers Studio",
      stackKey: "key1",
      generatedAt: "2026-07-27T00:00:00Z",
      rows: [
        { slug: "one", title: "First PR title", revision: 2, phase: "approved", headline: "One landed" },
        { slug: "two", title: "Second PR title", revision: 1, phase: "reviewing", headline: "" },
      ],
    });
    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain('href="one-r2.html"');
    expect(html).toContain('href="two-r1.html"');
    expect(html).toContain("One landed");
    expect(html).toContain("Second PR title");
    expect(html).toContain("approved");
  });
});

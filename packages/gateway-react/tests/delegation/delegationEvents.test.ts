// Unit coverage for the Effect-native event vocabulary behind foldDelegation:
// every durable record classifies into exactly one Data.TaggedEnum variant,
// and the fold dispatches with Match.tagsExhaustive — so classification must
// be TOTAL (unknown tables and malformed rows land on the `Ignored` variant
// instead of throwing or being silently dropped).
import { describe, expect, test } from "bun:test";
import { classifyDelegationRecord, DelegationEvent, TABLE_PRIORITY } from "../../src/delegation/delegationEvents.ts";
import { foldDelegation, type DelegationFoldIssue } from "../../src/delegation/foldDelegation.ts";
import type { DcPlanRow, DelegationRecord } from "../../src/delegation/types.ts";

function rec(table: string, nodeId: string, iteration: number, row: unknown): DelegationRecord {
  return { table, nodeId, iteration, row };
}

const est = { tokens: 1000, costUsd: 0.5, minutes: 5 };

const planRow: DcPlanRow = {
  logicalId: "root",
  tier: "fable",
  title: "root",
  brief: "Plan for root",
  children: [{ logicalId: "root/c1", tier: "sonnet", kind: "leaf", title: "c1", brief: "Build c1", estimate: est }],
  subtreeEstimate: est,
  risks: [],
};

describe("classifyDelegationRecord — totality", () => {
  test("a record with an unknown table classifies to Ignored (unknown-table)", () => {
    const record = rec("dcSomethingNew", "dc:root:mystery", 0, { logicalId: "root" });
    const event = classifyDelegationRecord(record);
    expect(event._tag).toBe("Ignored");
    if (DelegationEvent.$is("Ignored")(event)) {
      expect(event.reason).toBe("unknown-table");
      expect(event.record).toBe(record);
    }
  });

  test("a known table with a malformed row classifies to Ignored (malformed-row)", () => {
    const record = rec("dcPlan", "dc:root:plan", 0, { logicalId: 42 });
    const event = classifyDelegationRecord(record);
    expect(event._tag).toBe("Ignored");
    if (DelegationEvent.$is("Ignored")(event)) expect(event.reason).toBe("malformed-row");
  });

  test("every known output table has a non-Ignored classification for a valid row", () => {
    const samples: Array<[string, unknown, string]> = [
      ["dcGoal", { logicalId: "root", refinedPrompt: "p", assumptions: [], questionsAsked: 0 }, "GoalRefined"],
      [
        "dcQuestion",
        {
          logicalId: "root",
          seq: 1,
          question: "q",
          header: "h",
          kind: "text",
          recommended: "r",
          reason: "why",
          resolved: false,
        },
        "QuestionAsked",
      ],
      ["dcPlan", planRow, "PlanDeclared"],
      ["dcPreview", { logicalId: "root/c1", expectedOutput: "## out" }, "PreviewWritten"],
      ["dcGates", { logicalId: "root/c1", gates: [], depsLogical: [] }, "GatesDeclared"],
      [
        "dcProbe",
        {
          probeId: "root/p1",
          parentLogicalId: "root",
          kind: "poc",
          question: "q",
          answer: "a",
          report: "# r",
          planImpact: "none",
        },
        "ProbeReported",
      ],
      [
        "dcReplan",
        {
          round: 1,
          logicalId: "root/c1",
          decision: "reaffirmed",
          reason: "ok",
          trigger: { type: "probe", ref: "root/p1" },
        },
        "ReplanDecided",
      ],
      ["dcExec", { logicalId: "root/c1", attempt: 1, summary: "done", artifacts: [] }, "ExecFinished"],
      ["dcReview", { logicalId: "root/c1", attempt: 1, verdict: "pass", feedback: "good" }, "ReviewVerdict"],
      [
        "dcDevPreview",
        {
          logicalId: "root/c1",
          kind: "slideshow",
          title: "t",
          builtOk: true,
          artifact: { type: "markdown", content: "x" },
          summary: "s",
        },
        "DevPreviewBuilt",
      ],
      ["dcEdit", { editId: "e1", logicalId: "root/c1", editedOutput: {} }, "EditDelivered"],
      ["dcSkip", { skipped: true }, "PreviewsSkipped"],
      ["dcPoll", { answers: [{ question: "q", rating: 5 }] }, "PollSubmitted"],
      ["dcScore", { logicalId: "root", score: 0.9 }, "ScoreReported"],
    ];
    // Guard against vocabulary drift: the sample list covers every priority
    // table except the `_approval` marker (asserted separately below).
    expect(samples.map(([table]) => table).sort()).toEqual(
      Object.keys(TABLE_PRIORITY)
        .filter((table) => table !== "_approval")
        .sort(),
    );
    for (const [table, row, tag] of samples) {
      expect(classifyDelegationRecord(rec(table, `dc:x:${table}`, 0, row))._tag).toBe(tag);
    }
  });

  test("approval markers classify with a defaulted iteration", () => {
    const event = classifyDelegationRecord({ table: "_approval", nodeId: "dc:root:approve", pending: true });
    expect(event._tag).toBe("ApprovalMarked");
    if (DelegationEvent.$is("ApprovalMarked")(event)) {
      expect(event.iteration).toBe(0);
      expect(event.pending).toBe(true);
    }
    const malformed = classifyDelegationRecord({ table: "_approval", nodeId: "dc:root:approve" } as DelegationRecord);
    expect(malformed._tag).toBe("Ignored");
  });

  test("dcScore rows without a logicalId key by the physical node id", () => {
    const event = classifyDelegationRecord(rec("dcScore", "dc:root:score", 0, { score: 1 }));
    if (DelegationEvent.$is("ScoreReported")(event)) {
      expect(event.key).toBe("dc:root:score");
    } else {
      throw new Error(`expected ScoreReported, got ${event._tag}`);
    }
  });

  test("dcDevPreview classification carries the record iteration (the attempt marker)", () => {
    const event = classifyDelegationRecord(
      rec("dcDevPreview", "dc:root:c1:dev-preview", 3, {
        logicalId: "root/c1",
        kind: "app",
        title: "t",
        builtOk: false,
        artifact: { type: "url", url: "http://x" },
        summary: "s",
      }),
    );
    if (DelegationEvent.$is("DevPreviewBuilt")(event)) {
      expect(event.iteration).toBe(3);
    } else {
      throw new Error(`expected DevPreviewBuilt, got ${event._tag}`);
    }
  });
});

describe("foldDelegation — Match sink for Ignored events", () => {
  test("records classified as Ignored route to the ignored-list, never into the graph", () => {
    const issues: DelegationFoldIssue[] = [];
    const graph = foldDelegation(
      [
        rec("dcPlan", "dc:root:plan", 0, planRow),
        rec("dcTotallyUnknown", "dc:root:mystery", 0, { logicalId: "ghost" }),
        rec("dcExec", "dc:root:c1:exec", 0, "not-an-object"),
      ],
      { onIgnored: (issue) => issues.push(issue) },
    );
    expect(issues).toHaveLength(2);
    expect(issues.map((issue) => issue.reason).sort()).toEqual(["malformed-row", "unknown-table"]);
    expect(graph.nodes.ghost).toBeUndefined();
    expect(graph.nodes.root).toBeDefined();
    expect(graph.nodes["root/c1"]!.status).toBe("planned");
  });
});

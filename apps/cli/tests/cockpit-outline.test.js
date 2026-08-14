import { describe, expect, test } from "bun:test";
import {
  buildCockpitOutlineModel,
  buildOutlineFromNodes,
  clampScrollToSelection,
  effectiveDisplayState,
  formatAgentIdentity,
  formatSupervisorDigestLines,
  isSteerableAgent,
  displayWidth,
  layoutTitleBar,
  nodeDisplayLabel,
  phaseLoopLabel,
  renderCockpitOutlineFrame,
  supervisorRunStatus,
  toFullwidthLatin,
} from "../src/cockpit-outline.js";

describe("cockpit outline", () => {
  test("groups workers into parallel phase under outline", () => {
    const { phases, selectables } = buildOutlineFromNodes([
      { nodeId: "implement", state: "finished", lastAttempt: 1 },
      { nodeId: "worker-01", state: "in-progress", lastAttempt: 1 },
      { nodeId: "worker-02", state: "finished", lastAttempt: 1 },
      { nodeId: "worker-03", state: "failed", lastAttempt: 1 },
      { nodeId: "validate", state: "pending", lastAttempt: 0 },
    ]);
    expect(phases.some((p) => p.kind === "parallel")).toBe(true);
    expect(phases.some((p) => p.kind === "single" && p.title === "implement")).toBe(true);
    expect(phases.some((p) => p.kind === "single" && p.title === "validate")).toBe(true);
    const parallel = phases.find((p) => p.kind === "parallel");
    expect(parallel?.agents.length).toBe(3);
    expect(parallel?.expanded).toBe(true); // live/fail → expanded
    expect(selectables.some((s) => s.nodeId === "worker-03")).toBe(true);
  });

  test("groups research/probe/review fan-outs like smithering", () => {
    const { phases } = buildOutlineFromNodes([
      { nodeId: "brainstorm", state: "finished", lastAttempt: 1 },
      { nodeId: "research:domain", state: "finished", lastAttempt: 1 },
      { nodeId: "research:prior-art", state: "in-progress", lastAttempt: 1 },
      { nodeId: "questions", state: "pending", lastAttempt: 0 },
      { nodeId: "probe:a1", state: "finished", lastAttempt: 1 },
      { nodeId: "probe:a2", state: "finished", lastAttempt: 1 },
      { nodeId: "probe:synthesis", state: "pending", lastAttempt: 0 },
      { nodeId: "review:fable", state: "finished", lastAttempt: 1 },
      { nodeId: "review:codex", state: "finished", lastAttempt: 1 },
      { nodeId: "review:synthesis", state: "pending", lastAttempt: 0 },
    ]);
    const research = phases.find((p) => p.kind === "parallel" && p.title === "research");
    expect(research?.agents.map((a) => a.nodeId)).toEqual(["research:domain", "research:prior-art"]);
    const probes = phases.find((p) => p.kind === "parallel" && p.title === "probe");
    expect(probes?.agents.map((a) => a.nodeId)).toEqual(["probe:a1", "probe:a2"]);
    // synthesis stays a single phase
    expect(phases.some((p) => p.kind === "single" && p.agents[0]?.nodeId === "probe:synthesis")).toBe(true);
    const reviews = phases.find((p) => p.kind === "parallel" && p.title === "review");
    expect(reviews?.agents.map((a) => a.nodeId)).toEqual(["review:fable", "review:codex"]);
  });

  test("single agent phase is one selectable", () => {
    const { phases, selectables } = buildOutlineFromNodes([
      { nodeId: "planning", state: "in-progress", lastAttempt: 1 },
    ]);
    expect(phases).toHaveLength(1);
    expect(phases[0]?.kind).toBe("single");
    expect(selectables).toHaveLength(1);
    expect(selectables[0]?.nodeId).toBe("planning");
  });

  test("prefers author label over raw nodeId", () => {
    expect(nodeDisplayLabel({ nodeId: "implement", label: "Implement feature" })).toBe("Implement feature");
    const { phases, selectables } = buildOutlineFromNodes([
      { nodeId: "implement", label: "Implement feature", state: "finished", lastAttempt: 1 },
      { nodeId: "validate", state: "pending", lastAttempt: 0 },
    ]);
    expect(phases[0]?.title).toBe("Implement feature");
    expect(phases[0]?.agents[0]?.displayName).toBe("Implement feature");
    expect(selectables[0]?.label).toBe("Implement feature");
    expect(selectables[1]?.label).toBe("validate");
  });

  test("render outline has brand, phases, tree, tallies", () => {
    const model = buildCockpitOutlineModel({
      runId: "run-abc123456789",
      workflowName: "top-slow-demo",
      status: "running",
      live: true,
      nodes: [
        { nodeId: "implement", label: "Implement", state: "finished", lastAttempt: 1 },
        { nodeId: "worker-01", state: "in-progress", lastAttempt: 1 },
        { nodeId: "worker-02", state: "finished", lastAttempt: 1 },
        { nodeId: "validate", state: "pending", lastAttempt: 0 },
      ],
      startedAtMs: 0,
      nowMs: 12_000,
      tick: 4,
      lastPollAtMs: 11_500,
      herdrAvailable: true,
      selectedKey: "worker-01",
    });
    expect(model.tallies.w).toBe(1);
    expect(model.tallies.d).toBe(2);
    const lines = renderCockpitOutlineFrame(model, { rows: 28, cols: 72 });
    expect(lines).toHaveLength(28);
    const text = lines.join("\n");
    const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toMatch(/Workflow Supervisor/);
    expect(text).toMatch(/LIVE/);
    const plainTitle = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
    expect(plainTitle.includes("LIVE")).toBe(true);
    expect(plainTitle).toMatch(/Workflow Supervisor/);
    expect(plainTitle).toMatch(/SMITHERS/);
    expect(plain).toMatch(/Implement/);
    expect(plain).toContain("worker-01");
    expect(plain).toMatch(/parallel/i);
    expect(plain).toMatch(/[├└│]/); // sequence spine + nested fan-out
    expect(model.tallies.w).toBe(1); // run tallies
    // Sequence order (not alphabetical): implement before validate
    expect(plain.indexOf("Implement")).toBeLessThan(plain.indexOf("validate"));
    expect(text).toContain("Enter");
    expect(text).not.toContain("lingering");
    for (const line of lines) {
      const p = line.replace(/\x1b\[[0-9;]*m/g, "");
      // Fullwidth glyphs count as 2 display columns.
      expect(displayWidth(p)).toBe(72);
    }
  });

  test("header renders the data-path tag (via gateway / direct)", () => {
    const base = {
      runId: "run-src-1",
      workflowName: "deploy",
      status: "running",
      live: true,
      nodes: [{ nodeId: "build", state: "in-progress", lastAttempt: 1 }],
      startedAtMs: 0,
      nowMs: 5_000,
      lastPollAtMs: 4_500,
    };

    const gateway = buildCockpitOutlineModel({ ...base, sourceKind: "gateway" });
    expect(gateway.sourceKind).toBe("gateway");
    const gwTitle = renderCockpitOutlineFrame(gateway, { rows: 20, cols: 100 })[0].replace(/\x1b\[[0-9;]*m/g, "");
    expect(gwTitle).toContain("via gateway");
    expect(gwTitle).toContain("LIVE");

    const direct = buildCockpitOutlineModel({ ...base, sourceKind: "direct-db" });
    expect(direct.sourceKind).toBe("direct-db");
    const dbTitle = renderCockpitOutlineFrame(direct, { rows: 20, cols: 100 })[0].replace(/\x1b\[[0-9;]*m/g, "");
    expect(dbTitle).toContain("direct");
    expect(dbTitle).not.toContain("via gateway");

    // No sourceKind => no tag (byte-clean default header).
    const none = buildCockpitOutlineModel(base);
    expect(none.sourceKind).toBeUndefined();
    const noTitle = renderCockpitOutlineFrame(none, { rows: 20, cols: 100 })[0].replace(/\x1b\[[0-9;]*m/g, "");
    expect(noTitle).not.toContain("via gateway");
    expect(noTitle).not.toContain("direct");
  });

  test("preserves listNodes order (sequence), not alphabetical", () => {
    const { phases } = buildOutlineFromNodes([
      { nodeId: "setup", state: "finished", lastAttempt: 1 },
      { nodeId: "route", state: "finished", lastAttempt: 1 },
      { nodeId: "research:domain", state: "finished", lastAttempt: 1 },
      { nodeId: "research:prior-art", state: "finished", lastAttempt: 1 },
      { nodeId: "answers", state: "finished", lastAttempt: 1 },
    ]);
    expect(phases.map((p) => (p.kind === "single" ? p.agents[0]?.nodeId : p.title))).toEqual([
      "setup",
      "route",
      "research",
      "answers",
    ]);
  });

  test("loop label is 1-based current iter; no fake max for unbounded", () => {
    expect(phaseLoopLabel([{ iteration: 0 }, { iteration: 0 }])).toBe("");
    expect(phaseLoopLabel([{ iteration: 1 }, { iteration: 0 }])).toBe("iter 2");
    expect(phaseLoopLabel([{ iteration: 4 }])).toBe("iter 5");
  });

  test("only in-progress live agents are steerable", () => {
    expect(isSteerableAgent("in-progress", true)).toBe(true);
    expect(isSteerableAgent("in-progress", false)).toBe(false);
    expect(isSteerableAgent("finished", true)).toBe(false);
    expect(isSteerableAgent("pending", true)).toBe(false);
  });

  test("model marks steerable + shows loop label on phase", () => {
    const model = buildCockpitOutlineModel({
      runId: "r",
      status: "running",
      live: true,
      nodes: [
        { nodeId: "body", label: "Loop body", state: "in-progress", lastAttempt: 1, iteration: 2 },
        { nodeId: "after", label: "After", state: "pending", lastAttempt: 0, iteration: 0 },
      ],
    });
    expect(model.phases[0]?.loopLabel).toBe("iter 3");
    const body = model.selectables.find((s) => s.nodeId === "body");
    const after = model.selectables.find((s) => s.nodeId === "after");
    expect(body?.steerable).toBe(true);
    expect(after?.steerable).toBe(false);
    const plain = renderCockpitOutlineFrame(model, { rows: 14, cols: 64 })
      .join("\n")
      .replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toMatch(/iter 3/);
  });

  test("clampScrollToSelection keeps selection in viewport", () => {
    expect(clampScrollToSelection(0, 12, 40, 10)).toBe(3); // 12 must land in [3,12]
    expect(clampScrollToSelection(20, 5, 40, 10)).toBe(5);
    expect(clampScrollToSelection(0, -1, 40, 10)).toBe(0);
  });

  test("scroll clips tall outline and exposes layout meta", () => {
    const nodes = Array.from({ length: 30 }, (_, i) => ({
      nodeId: `step-${String(i).padStart(2, "0")}`,
      label: `Step ${i}`,
      state: i === 15 ? "in-progress" : i < 15 ? "finished" : "pending",
      lastAttempt: 1,
    }));
    const model = buildCockpitOutlineModel({
      runId: "tall",
      status: "running",
      live: true,
      nodes,
      selectedKey: "step-15",
      scrollOffset: 0,
    });
    /** @type {any} */
    const frame = renderCockpitOutlineFrame(model, { rows: 16, cols: 100 });
    expect(frame.bodyLen).toBeGreaterThan(frame.bodyBudget);
    expect(frame.scrollOffset).toBeGreaterThanOrEqual(0);
    // Selection on step-15 forces scroll away from 0 on a tall tree
    expect(frame.scrollOffset).toBeGreaterThan(0);
    const plain = frame.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toMatch(/Step 15/);
    expect(plain).toMatch(/\d+[–-]\d+\/\d+/); // scroll indicator in footer
  });

  test("idle/failed runs use static mark not braille spinner", () => {
    const model = buildCockpitOutlineModel({
      runId: "run-done",
      workflowName: "top-slow-demo",
      status: "failed",
      live: false,
      nodes: [
        { nodeId: "worker-01", state: "finished", lastAttempt: 1 },
        { nodeId: "worker-03", state: "failed", lastAttempt: 1 },
      ],
      startedAtMs: 0,
      nowMs: 5000,
      tick: 9,
      lastPollAtMs: 4800,
      herdrAvailable: true,
    });
    const text = renderCockpitOutlineFrame(model, { rows: 16, cols: 64 }).join("\n");
    const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toMatch(/IDLE|terminal/i);
    // Braille spinner frames should not appear when not live
    for (const ch of ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]) {
      expect(text).not.toContain(ch);
    }
    expect(plain).toMatch(/Workflow Supervisor/);
    expect(plain).toMatch(/IDLE/);
    // Full plural wordmark — never "SMITHER" (last-cell clip regressions).
    expect(plain).toMatch(/SMITHERS/);
    expect(plain).not.toMatch(/SMITHER[^S]/);
    expect(toFullwidthLatin("SMITHERS")).toBe("ＳＭＩＴＨＥＲＳ");
    const bar = layoutTitleBar("IDLE", "Workflow Supervisor", "X", 60);
    expect(bar.replace(/\x1b\[[0-9;]*m/g, "").startsWith("IDLE")).toBe(true);
    expect(bar.replace(/\x1b\[[0-9;]*m/g, "").endsWith("X")).toBe(true);
    expect(bar).toContain("Workflow Supervisor");
  });

  test("pending after hard fail paints as not reached", () => {
    expect(effectiveDisplayState("pending", "failed", false)).toBe("not-reached");
    expect(effectiveDisplayState("pending", "running", true)).toBe("pending");
    const model = buildCockpitOutlineModel({
      runId: "r-fail",
      workflowName: "camp-parallel",
      status: "failed",
      live: false,
      nodes: [
        { nodeId: "worker-01", state: "finished", lastAttempt: 1 },
        { nodeId: "worker-03", state: "failed", lastAttempt: 1 },
        { nodeId: "validate", state: "pending", lastAttempt: 0 },
      ],
      startedAtMs: 0,
      finishedAtMs: 8_000,
      nowMs: 20_000,
    });
    const plain = renderCockpitOutlineFrame(model, { rows: 20, cols: 72 })
      .join("\n")
      .replace(/\x1b\[[0-9;]*m/g, "");
    // Pending after hard fail → short status "skip" (not-reached)
    expect(plain).toMatch(/skip/i);
    expect(plain).toMatch(/fail/i);
  });

  test("supervisorRunStatus is a small display enum", () => {
    expect(supervisorRunStatus("running", true)).toBe("running");
    expect(supervisorRunStatus("waiting-approval", true)).toBe("waiting");
    expect(supervisorRunStatus("finished", false)).toBe("finished");
    expect(supervisorRunStatus("succeeded", false)).toBe("finished");
    expect(supervisorRunStatus("failed", false)).toBe("failed");
    expect(supervisorRunStatus("cancelled", false)).toBe("stopped");
    expect(supervisorRunStatus("stale", false)).toBe("stopped");
  });

  test("formatAgentIdentity prefers backend model effort", () => {
    expect(
      formatAgentIdentity({
        agentEngine: "ClaudeCodeAgent",
        agentModel: "claude-opus-4-8",
        effort: "xhigh",
      }),
    ).toBe("claude-code opus-4-8 xhigh");
    expect(formatAgentIdentity({ agentModel: "scripted-agent" })).toMatch(/scripted/);
    expect(
      formatAgentIdentity({
        agentEngine: "OpenCodeAgent",
        agentModel: "grok-4.5",
        reasoningEffort: "xhigh",
      }),
    ).toBe("opencode grok-4.5 xhigh");
  });

  test("formatSupervisorDigestLines is deterministic tallies without LLM prose", () => {
    const lines = formatSupervisorDigestLines({
      runId: "r1",
      status: "running",
      nodes: [
        { nodeId: "a", state: "in-progress" },
        { nodeId: "b", state: "waiting-approval" },
        { nodeId: "c", state: "finished" },
        { nodeId: "d", state: "failed" },
      ],
      queuedSteers: [{ nodeId: "a", status: "queued" }],
      startedAtMs: 0,
      nowMs: 60_000,
    });
    expect(lines.some((l) => /1 working · 1 blocked · 1 failed · 1 done/.test(l))).toBe(true);
    expect(lines.some((l) => /active: a/.test(l))).toBe(true);
    expect(lines.some((l) => /b blocked|d failed|steers: 1 queued/.test(l))).toBe(true);
    // No LLM chrome
    expect(lines.join("\n")).not.toMatch(/── digest/);
  });

  test("supervisor frame paints digest tallies under run strip (no fleet line)", () => {
    const model = buildCockpitOutlineModel({
      runId: "run-focus",
      workflowName: "demo",
      status: "running",
      live: true,
      nodes: [
        { nodeId: "implement", state: "in-progress", lastAttempt: 1 },
        { nodeId: "gate", state: "waiting-approval", lastAttempt: 1 },
      ],
      queuedSteers: [{ nodeId: "implement", status: "queued" }],
      startedAtMs: 0,
      nowMs: 30_000,
      selectedKey: "implement",
    });
    expect(model.digestLines.length).toBeGreaterThan(0);
    expect(model.fleetStrip).toBeUndefined();
    const plain = renderCockpitOutlineFrame(model, { rows: 28, cols: 100 })
      .join("\n")
      .replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toMatch(/working/);
    expect(plain).not.toMatch(/fleet:/);
    expect(plain).toMatch(/steers: 1 queued|gate blocked/);
  });

  test("wide TTY shows full run id and status/attempts/backend/model columns", () => {
    const model = buildCockpitOutlineModel({
      runId: "smithering-outline-mrmg3tyk",
      workflowName: "smithering",
      status: "running",
      live: true,
      nodes: [
        {
          nodeId: "intake",
          label: "Intake",
          state: "in-progress",
          lastAttempt: 1,
        },
      ],
      agentMetaByNode: {
        intake: {
          agentEngine: "claude-code",
          agentModel: "claude-fable-5",
          effort: "high",
        },
      },
      selectedKey: "intake",
      startedAtMs: 0,
      nowMs: 12_000,
    });
    const plain = renderCockpitOutlineFrame(model, { rows: 22, cols: 120 })
      .join("\n")
      .replace(/\x1b\[[0-9;]*m/g, "");
    // Full run id + workflow when there is room
    expect(plain).toContain("smithering-outline-mrmg3tyk");
    expect(plain).toMatch(/workflow:\s*smithering/);
    // Column headers
    expect(plain).toMatch(/status/);
    expect(plain).toMatch(/attempts/);
    expect(plain).toMatch(/backend/);
    expect(plain).toMatch(/\bmodel\b/);
    // Split columns: backend separate from model+effort
    expect(plain).toMatch(/claude-code/);
    expect(plain).toMatch(/fable-5\s+high/);
  });

  test("elapsed freezes at finishedAtMs when terminal", () => {
    const model = buildCockpitOutlineModel({
      runId: "r1",
      status: "finished",
      live: false,
      nodes: [{ nodeId: "hello", state: "finished", lastAttempt: 1 }],
      startedAtMs: 1_000,
      finishedAtMs: 6_000,
      nowMs: 100_000, // wall clock continues; elapsed must not
      agentMetaByNode: {
        hello: { agentModel: "scripted-agent" },
      },
    });
    expect(model.elapsedLabel).toMatch(/5s|0m 5s/);
    expect(model.elapsedLabel).not.toMatch(/1m|99s|100/);
    const text = renderCockpitOutlineFrame(model, { rows: 12, cols: 70 }).join("\n");
    expect(text).toMatch(/scripted/);
    expect(text.replace(/\x1b\[[0-9;]*m/g, "")).toMatch(/workflow:.*status:.*time:/i);
    expect(text.replace(/\x1b\[[0-9;]*m/g, "")).not.toMatch(/complete ·/i);
  });

  test("expandOverrides can collapse parallel", () => {
    const nodes = [
      { nodeId: "worker-01", state: "finished", lastAttempt: 1 },
      { nodeId: "worker-02", state: "finished", lastAttempt: 1 },
    ];
    const { phases } = buildOutlineFromNodes(nodes);
    const id = phases[0]?.id;
    expect(id).toBeTruthy();
    const model = buildCockpitOutlineModel({
      runId: "r",
      status: "finished",
      nodes,
      expandOverrides: { [id]: false },
      selectedKey: `phase:${id}`,
    });
    const parallel = model.phases.find((p) => p.kind === "parallel");
    expect(parallel?.expanded).toBe(false);
    // agents not in selectables when collapsed (only phase header)
    expect(
      model.selectables.every((s) => s.kind === "phase" || s.nodeId == null || !String(s.nodeId).startsWith("worker")),
    ).toBe(true);
  });

  test("activity strip shows last tools for selected agent", () => {
    const model = buildCockpitOutlineModel({
      runId: "run-act",
      workflowName: "smithering",
      status: "running",
      live: true,
      nodes: [
        { nodeId: "intake", label: "Intake", state: "in-progress", lastAttempt: 1 },
        { nodeId: "brainstorm", label: "Brainstorm", state: "pending", lastAttempt: 0 },
      ],
      selectedKey: "intake",
      selectedActivity: {
        nodeId: "intake",
        label: "Intake",
        lines: [
          { id: "1", kind: "tool", title: "Read", status: "done", detail: "foo.md", seq: 1 },
          { id: "2", kind: "tool", title: "Bash", status: "running", detail: "echo hi", seq: 2 },
          { id: "3", kind: "tool", title: "Write", status: "done", detail: "out.md", seq: 3 },
          { id: "4", kind: "tool", title: "Grep", status: "done", detail: "intake", seq: 4 },
        ],
      },
      startedAtMs: 0,
      nowMs: 8_000,
    });
    expect(model.selectedActivity?.lines).toHaveLength(4);
    const plain = renderCockpitOutlineFrame(model, { rows: 24, cols: 72 })
      .join("\n")
      .replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toMatch(/activity · Intake/i);
    expect(plain).toMatch(/Read/);
    expect(plain).toMatch(/Bash/);
    expect(plain).toMatch(/Write/);
    expect(plain).toMatch(/Grep/);
    // key footer still present below the strip
    expect(plain).toMatch(/j\/k select/i);
  });

  test("activity strip empty state when agent has no tools yet", () => {
    const model = buildCockpitOutlineModel({
      runId: "run-empty-act",
      status: "running",
      live: true,
      nodes: [{ nodeId: "route", state: "in-progress", lastAttempt: 1 }],
      selectedKey: "route",
      selectedActivity: { nodeId: "route", label: "route", lines: [] },
    });
    const plain = renderCockpitOutlineFrame(model, { rows: 18, cols: 64 })
      .join("\n")
      .replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toMatch(/activity · route/i);
    expect(plain).toMatch(/no recent tools/i);
  });

  test("phase selection keeps fixed activity strip without tool lines", () => {
    const nodes = [
      { nodeId: "worker-01", state: "in-progress", lastAttempt: 1 },
      { nodeId: "worker-02", state: "finished", lastAttempt: 1 },
    ];
    const { phases } = buildOutlineFromNodes(nodes);
    const phaseId = phases[0]?.id;
    const model = buildCockpitOutlineModel({
      runId: "r",
      status: "running",
      live: true,
      nodes,
      selectedKey: `phase:${phaseId}`,
      selectedActivity: {
        nodeId: "worker-01",
        lines: [{ id: "1", title: "Bash", status: "running", seq: 1 }],
      },
    });
    // Phase strip stays mounted (stable layout) but does not show agent tools.
    expect(model.selectedActivity?.kind).toBe("phase");
    expect(model.selectedActivity?.lines).toEqual([]);
    const plain = renderCockpitOutlineFrame(model, { rows: 20, cols: 64 })
      .join("\n")
      .replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toMatch(/activity ·/i);
    expect(plain).toMatch(/phase · Enter expand\/collapse/i);
    expect(plain).not.toMatch(/Bash/);
  });

  test("super-long sequence requires scroll; ends stay reachable", () => {
    const N = 80;
    const nodes = Array.from({ length: N }, (_, i) => ({
      nodeId: `stage-${String(i).padStart(3, "0")}`,
      label: `Stage ${i}`,
      state: i < N - 1 ? "finished" : "in-progress",
      lastAttempt: 1,
    }));
    // Select last stage → viewport must scroll near the bottom
    const modelEnd = buildCockpitOutlineModel({
      runId: "long-seq",
      workflowName: "super-long-fixture",
      status: "running",
      live: true,
      nodes,
      selectedKey: `stage-${String(N - 1).padStart(3, "0")}`,
      scrollOffset: 0,
    });
    /** @type {any} */
    const frameEnd = renderCockpitOutlineFrame(modelEnd, { rows: 20, cols: 100 });
    expect(frameEnd.bodyLen).toBeGreaterThan(frameEnd.bodyBudget);
    expect(frameEnd.scrollOffset).toBeGreaterThan(20);
    const plainEnd = frameEnd.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(plainEnd).toMatch(/Stage 79/);
    expect(plainEnd).not.toMatch(/Stage 0\b/); // first row scrolled off
    expect(plainEnd).toMatch(/\d+[–-]\d+\/\d+/);

    // Select first stage with a high scrollOffset → clamp scrolls back up
    const modelTop = buildCockpitOutlineModel({
      runId: "long-seq",
      status: "running",
      live: true,
      nodes,
      selectedKey: "stage-000",
      scrollOffset: 50,
    });
    /** @type {any} */
    const frameTop = renderCockpitOutlineFrame(modelTop, { rows: 20, cols: 100 });
    // Legend may occupy body index 0; selection clamp lands at or near top.
    expect(frameTop.scrollOffset).toBeLessThanOrEqual(1);
    const plainTop = frameTop.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(plainTop).toMatch(/Stage 0/);
  });

  test("wide nested parallel fan-outs: multi-phase, maxShow truncation, scroll", () => {
    /** @type {Array<{ nodeId: string, label?: string, state: string, lastAttempt: number }>} */
    const nodes = [
      { nodeId: "setup", label: "Setup", state: "finished", lastAttempt: 1 },
      { nodeId: "route", label: "Route", state: "finished", lastAttempt: 1 },
    ];
    // Three consecutive fan-out blocks (research / probe / workers)
    for (let i = 0; i < 20; i++) {
      nodes.push({
        nodeId: `research:topic-${String(i).padStart(2, "0")}`,
        label: `Research ${i}`,
        state: i === 3 ? "in-progress" : "finished",
        lastAttempt: 1,
      });
    }
    nodes.push({ nodeId: "questions", label: "Questions", state: "pending", lastAttempt: 0 });
    for (let i = 0; i < 15; i++) {
      nodes.push({
        nodeId: `probe:a${i}`,
        label: `Probe ${i}`,
        state: "pending",
        lastAttempt: 0,
      });
    }
    nodes.push({ nodeId: "probe:synthesis", label: "Probe synthesis", state: "pending", lastAttempt: 0 });
    for (let i = 1; i <= 18; i++) {
      nodes.push({
        nodeId: `worker-${String(i).padStart(2, "0")}`,
        state: "pending",
        lastAttempt: 0,
      });
    }
    nodes.push({ nodeId: "validate", label: "Validate", state: "pending", lastAttempt: 0 });

    const { phases } = buildOutlineFromNodes(nodes);
    const parallelPhases = phases.filter((p) => p.kind === "parallel");
    expect(parallelPhases.length).toBeGreaterThanOrEqual(3);
    // research block has 20 agents
    const research = parallelPhases.find((p) => p.title === "research");
    expect(research?.agents.length).toBe(20);
    expect(research?.expanded).toBe(true); // live/fail expands

    // Full-height paint exposes maxShow truncation (+N more) for 20 research agents.
    const modelTall = buildCockpitOutlineModel({
      runId: "nested-fanout",
      workflowName: "nested-parallel-fixture",
      status: "running",
      live: true,
      nodes,
      selectedKey: "research:topic-03",
      scrollOffset: 0,
    });
    /** @type {any} */
    const frameTall = renderCockpitOutlineFrame(modelTall, { rows: 48, cols: 110 });
    const plainTall = frameTall.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    // Nested under research group (tree spine), all agents listed (no maxShow in graph paint)
    expect(plainTall).toMatch(/Research 3/);
    expect(plainTall).toMatch(/│/);
    expect(plainTall).toMatch(/probe|worker|Validate/i);
    // Nested tree spine present under parallel phase
    expect(plainTall).toMatch(/[│├└]/);
    // All parallel phases expand by default (including large pending probe/workers).
    expect(modelTall.selectables.filter((s) => s.kind === "agent").length).toBeGreaterThan(40);
    expect(modelTall.selectables.some((s) => s.kind === "phase")).toBe(true);
    expect(modelTall.phases.filter((p) => p.kind === "parallel").every((p) => p.expanded)).toBe(true);

    // Short viewport: body overflows and scroll meta is exposed
    /** @type {any} */
    const frameShort = renderCockpitOutlineFrame(modelTall, { rows: 18, cols: 110 });
    expect(frameShort.bodyLen).toBeGreaterThan(frameShort.bodyBudget);
    expect(frameShort.bodyKeys.length).toBeGreaterThan(frameShort.bodyBudget);
  });

  test("freeScroll does not yank viewport back to selection", () => {
    const nodes = Array.from({ length: 40 }, (_, i) => ({
      nodeId: `stage-${String(i).padStart(2, "0")}`,
      label: `Stage ${i}`,
      state: i === 5 ? "in-progress" : "finished",
      lastAttempt: 1,
    }));
    const model = buildCockpitOutlineModel({
      runId: "free",
      status: "running",
      live: true,
      nodes,
      selectedKey: "stage-05",
      scrollOffset: 20,
      freeScroll: true,
    });
    /** @type {any} */
    const frame = renderCockpitOutlineFrame(model, { rows: 16, cols: 80 });
    // freeScroll keeps offset 20 (clamped only to max), even if selection is above
    expect(frame.scrollOffset).toBeGreaterThanOrEqual(15);
    const plain = frame.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    // Selection may be off-screen in free-scroll mode
    expect(plain).toMatch(/Stage 2\d/);
  });

  test("multi-wave nested parallels group as separate phases", () => {
    const nodes = [
      { nodeId: "setup", state: "finished", lastAttempt: 1 },
      ...Array.from({ length: 8 }, (_, i) => ({
        nodeId: `research:a${i}`,
        state: "finished",
        lastAttempt: 1,
      })),
      { nodeId: "prd", state: "finished", lastAttempt: 1 },
      ...Array.from({ length: 6 }, (_, i) => ({
        nodeId: `probe:b${i}`,
        state: "in-progress",
        lastAttempt: 1,
      })),
      { nodeId: "probe:synthesis", state: "pending", lastAttempt: 0 },
      ...Array.from({ length: 5 }, (_, i) => ({
        nodeId: `review:${["fable", "codex", "sonnet", "opus", "fast"][i]}`,
        state: "pending",
        lastAttempt: 0,
      })),
      { nodeId: "review:synthesis", state: "pending", lastAttempt: 0 },
      ...Array.from({ length: 12 }, (_, i) => ({
        nodeId: `worker-${String(i + 1).padStart(2, "0")}`,
        state: "pending",
        lastAttempt: 0,
      })),
      { nodeId: "validate", state: "pending", lastAttempt: 0 },
    ];
    const { phases } = buildOutlineFromNodes(nodes);
    const titles = phases.map((p) => (p.kind === "parallel" ? p.title : p.agents[0]?.nodeId));
    expect(titles).toContain("research");
    expect(titles).toContain("probe");
    expect(titles).toContain("review");
    expect(titles).toContain("parallel"); // workers
    expect(titles.filter((t) => t === "research" || t === "probe" || t === "review" || t === "parallel").length).toBe(
      4,
    );
    const model = buildCockpitOutlineModel({
      runId: "multi",
      status: "running",
      live: true,
      nodes,
      selectedKey: "probe:b0",
    });
    /** @type {any} */
    const frame = renderCockpitOutlineFrame(model, { rows: 32, cols: 100 });
    const plain = frame.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toMatch(/research/i);
    expect(plain).toMatch(/probe/i);
    expect(model.selectables.some((s) => s.kind === "phase")).toBe(true);
  });

  test("collapsed parallel phase is one selectable; expand surfaces agents", () => {
    const nodes = Array.from({ length: 16 }, (_, i) => ({
      nodeId: `worker-${String(i + 1).padStart(2, "0")}`,
      state: "finished",
      lastAttempt: 1,
    }));
    const { phases } = buildOutlineFromNodes(nodes);
    const phaseId = phases[0]?.id;
    const collapsed = buildCockpitOutlineModel({
      runId: "r",
      status: "finished",
      live: false,
      nodes,
      expandOverrides: { [phaseId]: false },
      selectedKey: `phase:${phaseId}`,
    });
    expect(collapsed.selectables).toHaveLength(1);
    expect(collapsed.selectables[0]?.kind).toBe("phase");
    const plainC = renderCockpitOutlineFrame(collapsed, { rows: 16, cols: 80 })
      .join("\n")
      .replace(/\x1b\[[0-9;]*m/g, "");
    expect(plainC).toMatch(/16 agents|parallel/i);
    expect(plainC).not.toMatch(/worker-01/);

    const expanded = buildCockpitOutlineModel({
      runId: "r",
      status: "finished",
      live: false,
      nodes,
      expandOverrides: { [phaseId]: true },
      selectedKey: "worker-12",
    });
    expect(expanded.selectables.length).toBe(1 + 16); // phase + agents
    /** @type {any} */
    const frameE = renderCockpitOutlineFrame(expanded, { rows: 28, cols: 80 });
    const plainE = frameE.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(plainE).toMatch(/worker-12/);
    // Graph/tree paint lists all agents under the group (no maxShow truncation).
    expect(plainE).toMatch(/worker-01/);
    expect(frameE.bodyKeys.filter(Boolean).length).toBeGreaterThan(12);
  });
});

/** @jsxImportSource smithers-orchestrator */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { Gateway } from "../src/gateway.js";

// The gateway resolves `.smithers/ui/<key>.tsx` (a sibling of the workflow's
// `workflows/` dir) by convention AT REQUEST TIME, so a UI file authored while
// the gateway is running becomes servable with no workflow edit (which would
// break parked runs' resume hashes) and no gateway restart. See create-ui.

describe("convention workflow UI resolution", () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-convention-ui-"));

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeWorkflow(name: string) {
    const { smithers, Workflow, Task } = createSmithers(
      { out: z.object({ value: z.number() }) },
      { dbPath: join(root, `${name}.db`) },
    );
    return smithers(() => (
      <Workflow name={name}>
        <Task id="t">{{ value: 1 }}</Task>
      </Workflow>
    ));
  }

  test("a ui/<key>.tsx created after register becomes visible with no restart", () => {
    mkdirSync(join(root, "workflows"), { recursive: true });
    const entryFile = join(root, "workflows", "probe.tsx");
    writeFileSync(entryFile, "// entry placeholder\n", "utf8");

    const gateway = new Gateway({});
    gateway.register("probe", makeWorkflow("probe"), { entryFile });
    const entry = (gateway as any).workflows.get("probe");

    // Before the convention file exists: no UI anywhere.
    expect((gateway as any).workflowSummary("probe", entry).hasUi).toBe(false);
    expect(gateway.getUiMounts().some((mount: any) => mount.workflowKey === "probe")).toBe(false);

    // Author the UI file mid-flight — exactly what the create-ui workflow does.
    mkdirSync(join(root, "ui"), { recursive: true });
    const uiFile = join(root, "ui", "probe.tsx");
    writeFileSync(uiFile, "// ui placeholder\n", "utf8");

    const summary = (gateway as any).workflowSummary("probe", entry);
    expect(summary.hasUi).toBe(true);
    expect(summary.uiPath).toBe("/workflows/probe");
    const mount = gateway.getUiMounts().find((candidate: any) => candidate.workflowKey === "probe");
    expect(mount?.config.entry).toBe(uiFile);

    // Deleting the file withdraws it just as live.
    rmSync(uiFile, { force: true });
    expect((gateway as any).workflowSummary("probe", entry).hasUi).toBe(false);
  });

  test("a declared <UI>/options ui always wins over the convention file", () => {
    mkdirSync(join(root, "workflows"), { recursive: true });
    mkdirSync(join(root, "ui"), { recursive: true });
    const entryFile = join(root, "workflows", "declared.tsx");
    writeFileSync(entryFile, "// entry placeholder\n", "utf8");
    writeFileSync(join(root, "ui", "declared.tsx"), "// convention ui\n", "utf8");
    const declaredEntry = join(root, "ui", "explicit-entry.tsx");
    writeFileSync(declaredEntry, "// declared ui\n", "utf8");

    const gateway = new Gateway({});
    gateway.register("declared", makeWorkflow("declared"), { entryFile, ui: { entry: declaredEntry } });
    const mount = gateway.getUiMounts().find((candidate: any) => candidate.workflowKey === "declared");
    expect(mount?.config.entry).toBe(declaredEntry);
  });

  test("workflows registered without an entryFile are untouched", () => {
    const gateway = new Gateway({});
    gateway.register("bare", makeWorkflow("bare"));
    const entry = (gateway as any).workflows.get("bare");
    expect((gateway as any).workflowSummary("bare", entry).hasUi).toBe(false);
  });
});

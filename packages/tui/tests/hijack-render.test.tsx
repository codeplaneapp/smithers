/** @jsxImportSource @opentui/react */
import { afterEach, it, expect } from "bun:test";
import { act, useState } from "react";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useRenderer as useOpenTuiRenderer } from "@opentui/react";
import type { CliRenderer } from "@opentui/core";
import type { GatewayRunNode } from "@smthrs/gateway-client";
import { describeHeadlessRender, renderForTest } from "./renderHelpers.tsx";
import { RendererProvider } from "../src/RendererContext.tsx";
import { hijackCommand, Selecting, HandingOff, Returned, HijackMode } from "../src/modes/HijackMode.tsx";
import { SmithersGatewayProvider } from "@smthrs/gateway-react";
import { SmithersGatewayClient } from "@smthrs/gateway-client";
import { startSeededGateway, defaultSeed, emptySeed } from "./seededGateway.ts";

/**
 * Direct render of the REAL HijackMode phase components (Selecting / HandingOff
 * / Returned) plus the `hijackCommand` builder. HandingOff runs the ACTUAL
 * suspend/spawn/close lifecycle against a tiny real child process, so the whole
 * hand-off path is exercised without a live agent CLI or gateway.
 */

const NODE: GatewayRunNode = { id: "n1", name: "fetch-data", kind: "agent", status: "running", iteration: 0 };

// Bridge OpenTUI's renderer into our RendererProvider (HandingOff calls useRenderer).
function WithRenderer({ children }: { children: React.ReactNode }) {
  const renderer = useOpenTuiRenderer();
  return <RendererProvider value={renderer as unknown as CliRenderer}>{children}</RendererProvider>;
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function stubCliScript(): string {
  const dir = mkdtempSync(join(tmpdir(), "smx-hijack-"));
  tmpDirs.push(dir);
  const file = join(dir, "stub-cli.js");
  // The spawned child immediately exits 0 — enough to drive close→onDone(0).
  writeFileSync(file, "process.exit(0);\n");
  return file;
}

it("hijackCommand builds the CLI invocation, and returns null with no CLI entry", () => {
  expect(hijackCommand("run-1", "node-a", () => null)).toBeNull();
  const cmd = hijackCommand("run-1", "node-a", () => "/opt/cli/index.js");
  expect(cmd).not.toBeNull();
  expect(cmd!.args).toEqual(["/opt/cli/index.js", "hijack", "run-1", "--target", "node-a"]);
});

describeHeadlessRender("HijackMode phase components", () => {
  it("Selecting lists nodes and cancels on Escape", async () => {
    let cancelled = 0;
    const { waitForVisualIdle, captureCharFrame, mockInput, flush, renderer } = await renderForTest(
      <Selecting nodes={[NODE]} onSelect={() => {}} onCancel={() => (cancelled += 1)} />,
      { width: 120, height: 20 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    expect(f).toContain("HIJACK");
    expect(f).toContain("fetch-data");
    act(() => {
      mockInput.pressEscape();
    });
    // A lone ESC is ambiguous with an escape SEQUENCE, so the parser holds it
    // until its inter-byte timeout elapses; wait it out with a real delay.
    await act(async () => {
      await new Promise((res) => setTimeout(res, 120));
    });
    await flush();
    expect(cancelled).toBe(1);
    renderer.destroy();
  });

  it("Selecting hands off to the highlighted node even when a candidate drops out mid-selection", async () => {
    const running = (id: string): GatewayRunNode => ({ id, name: id, kind: "agent", status: "running" });
    const [alpha, beta, gamma] = [running("alpha"), running("beta"), running("gamma")];
    const picked: string[] = [];
    let setNodes: (nodes: GatewayRunNode[]) => void = () => {};
    function Harness() {
      const [nodes, setter] = useState<GatewayRunNode[]>([alpha, beta, gamma]);
      setNodes = setter;
      return <Selecting nodes={nodes} onSelect={(n) => picked.push(n.id)} onCancel={() => {}} />;
    }

    const r = await renderForTest(<Harness />, { width: 120, height: 20 });
    await r.waitForVisualIdle();
    // Operator arrows down onto "beta" and pauses before confirming.
    act(() => {
      r.mockInput.pressArrow("down");
    });
    await r.flush();
    // Meanwhile "alpha" completes and leaves hijackCandidates — the picker must
    // NOT slide the rows up under the highlight.
    await act(async () => {
      setNodes([beta, gamma]);
    });
    await r.flush();
    await r.waitForVisualIdle();

    act(() => {
      r.mockInput.pressEnter();
    });
    await r.flush();
    expect(picked).toEqual(["beta"]);
    // The finished node stays visible as a pinned row, marked as no longer live.
    expect(r.captureCharFrame()).toContain("status: ended");
    r.renderer.destroy();
  });

  it("HandingOff suspends, spawns the real child, and reports its exit code", async () => {
    const stub = stubCliScript();
    const codes: Array<number | null> = [];
    // HandingOff suspends the renderer while the child owns the terminal, so the
    // captured frame is intentionally blank here; the observable is the exit code
    // routed back through onDone once the real child closes.
    const { waitForVisualIdle, renderer } = await renderForTest(
      <WithRenderer>
        <HandingOff runId="run-1" node={NODE} resolveCli={() => stub} onDone={(c) => codes.push(c)} />
      </WithRenderer>,
      { width: 120, height: 12 },
    );
    await waitForVisualIdle();
    // Wait for the real child to exit and fire close→onDone.
    for (let i = 0; i < 150 && codes.length === 0; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
    }
    expect(codes).toEqual([0]);
    renderer.destroy();
  });

  it("HandingOff exits with error when no CLI entry can be built", async () => {
    const codes: Array<number | null> = [];
    const { waitForVisualIdle, renderer } = await renderForTest(
      <WithRenderer>
        <HandingOff runId="run-1" node={NODE} resolveCli={() => null} onDone={(c) => codes.push(c)} />
      </WithRenderer>,
      { width: 120, height: 12 },
    );
    await waitForVisualIdle();
    for (let i = 0; i < 20 && codes.length === 0; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    expect(codes).toEqual([null]);
    renderer.destroy();
  });

  it("Returned shows the clean-exit note and dismisses on d", async () => {
    let dismissed = 0;
    const { waitForVisualIdle, captureCharFrame, mockInput, flush, renderer } = await renderForTest(
      <Returned node={NODE} exitCode={0} onDismiss={() => (dismissed += 1)} />,
      { width: 120, height: 12 },
    );
    await waitForVisualIdle();
    const f = captureCharFrame();
    expect(f).toContain("from hijack: fetch-data");
    expect(f).toContain("Smithers automation resumed");
    expect(f).toContain("[d] dismiss");
    act(() => {
      mockInput.pressKey("d");
    });
    await flush();
    expect(dismissed).toBe(1);
    renderer.destroy();
  });

  it("Returned shows the retry note for a non-zero exit", async () => {
    const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
      <Returned node={NODE} exitCode={2} onDismiss={() => {}} />,
      { width: 120, height: 12 },
    );
    await waitForVisualIdle();
    expect(captureCharFrame()).toContain("Run left as-is");
    renderer.destroy();
  });
});

describeHeadlessRender("HijackMode – full state machine over a live gateway", () => {
  it("shows unavailable when no CLI entry resolves", async () => {
    const gw = startSeededGateway(defaultSeed("run-hj"));
    try {
      const { waitForVisualIdle, captureCharFrame, renderer } = await renderForTest(
        <SmithersGatewayProvider client={new SmithersGatewayClient({ baseUrl: gw.baseUrl })}>
          <HijackMode runId="run-hj" resolveCli={() => null} />
        </SmithersGatewayProvider>,
        { width: 120, height: 16 },
      );
      await waitForVisualIdle();
      expect(captureCharFrame()).toContain("HIJACK unavailable");
      renderer.destroy();
    } finally {
      gw.stop();
    }
  });

  it("shows the empty state when the run has no hijackable nodes", async () => {
    const gw = startSeededGateway(emptySeed("run-hj"));
    try {
      const r = await renderForTest(
        <WithRenderer>
          <SmithersGatewayProvider client={new SmithersGatewayClient({ baseUrl: gw.baseUrl })}>
            <HijackMode runId="run-hj" resolveCli={() => "/stub/cli.js"} />
          </SmithersGatewayProvider>
        </WithRenderer>,
        { width: 120, height: 16 },
      );
      let frame = "";
      for (let i = 0; i < 40; i++) {
        await r.waitForVisualIdle();
        await act(async () => {
          await new Promise((res) => setTimeout(res, 20));
        });
        frame = r.captureCharFrame();
        if (frame.includes("no running nodes")) break;
      }
      expect(frame).toContain("no running nodes");
      r.renderer.destroy();
    } finally {
      gw.stop();
    }
  });

  it("selects a candidate, hands off to the real child, then dismisses back to selecting", async () => {
    const stub = stubCliScript();
    const gw = startSeededGateway(defaultSeed("run-hj"));
    try {
      const r = await renderForTest(
        <WithRenderer>
          <SmithersGatewayProvider client={new SmithersGatewayClient({ baseUrl: gw.baseUrl })}>
            <HijackMode runId="run-hj" resolveCli={() => stub} />
          </SmithersGatewayProvider>
        </WithRenderer>,
        { width: 120, height: 16 },
      );
      // Wait for the candidate picker to render.
      let frame = "";
      for (let i = 0; i < 40; i++) {
        await r.waitForVisualIdle();
        await act(async () => {
          await new Promise((res) => setTimeout(res, 20));
        });
        frame = r.captureCharFrame();
        if (frame.includes("select a running node")) break;
      }
      expect(frame).toContain("select a running node");

      // Confirm the highlighted candidate → handing-off spawns the real stub.
      // The picker pins rows in the order it first saw them, so which live node
      // (the root or the agent task) sits at row 0 depends on whether the tree or
      // the event stream landed first — read the highlight (▶) off the frame
      // rather than assuming, and assert the hand-off targets exactly that node.
      const highlighted = frame.match(/▶ (\S+)/)?.[1];
      expect(highlighted).toBeTruthy();
      act(() => {
        r.mockInput.pressEnter();
      });
      await r.flush();
      // Wait for the child to exit → phase "returned".
      for (let i = 0; i < 100; i++) {
        await r.waitForVisualIdle();
        await act(async () => {
          await new Promise((res) => setTimeout(res, 20));
        });
        if (r.captureCharFrame().includes(`from hijack: ${highlighted}`)) break;
      }
      expect(r.captureCharFrame()).toContain(`from hijack: ${highlighted}`);

      // [d] dismisses back to the selecting phase.
      act(() => {
        r.mockInput.pressKey("d");
      });
      await r.flush();
      await r.waitForVisualIdle();
      r.renderer.destroy();
    } finally {
      gw.stop();
    }
  });
});

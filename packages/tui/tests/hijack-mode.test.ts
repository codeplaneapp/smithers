import { describe, it, expect } from "bun:test";
import type { GatewayRunNode } from "@smithers-orchestrator/gateway-client";
import {
  runningNodes,
  nodeSelectOption,
  hijackExitMessage,
  startHijackSession,
  killHijackChild,
  type HijackChildLike,
} from "../src/modes/hijackUtils.ts";

function node(id: string, overrides: Partial<GatewayRunNode> = {}): GatewayRunNode {
  return { id, name: id, kind: "task", status: "done", ...overrides };
}

// ─── runningNodes ─────────────────────────────────────────────────────────────

describe("runningNodes", () => {
  it("returns empty for empty input", () => {
    expect(runningNodes([])).toHaveLength(0);
  });

  it("returns only running nodes", () => {
    const nodes = [
      node("a", { status: "running" }),
      node("b", { status: "done" }),
      node("c", { status: "active" }),
      node("d", { status: "waiting" }),
      node("e", { status: "failed" }),
    ];
    const result = runningNodes(nodes);
    expect(result.map((n) => n.id)).toEqual(["a", "c"]);
  });

  it("accepts 'active' as running", () => {
    const nodes = [node("x", { status: "active" })];
    expect(runningNodes(nodes)).toHaveLength(1);
  });

  it("excludes waiting, queued, done, failed", () => {
    const statuses = ["waiting", "queued", "done", "failed", "error", "pending"];
    const nodes = statuses.map((s, i) => node(`n${i}`, { status: s }));
    expect(runningNodes(nodes)).toHaveLength(0);
  });
});

// ─── nodeSelectOption ─────────────────────────────────────────────────────────

describe("nodeSelectOption", () => {
  it("uses node name as select name", () => {
    const opt = nodeSelectOption(node("n1", { name: "my-task" }));
    expect(opt.name).toBe("my-task");
  });

  it("falls back to node id when name is absent", () => {
    const n = node("n1");
    (n as any).name = undefined;
    const opt = nodeSelectOption(n);
    expect(opt.name).toBe("n1");
  });

  it("sets value to node id", () => {
    const opt = nodeSelectOption(node("abc-123"));
    expect(opt.value).toBe("abc-123");
  });

  it("includes node id, kind, and status in description", () => {
    const opt = nodeSelectOption(node("n1", { kind: "agent", status: "running" }));
    expect(opt.description).toContain("n1");
    expect(opt.description).toContain("agent");
    expect(opt.description).toContain("running");
  });

  it("handles unknown kind gracefully", () => {
    const n = node("n2", { status: "active" });
    (n as any).kind = undefined;
    const opt = nodeSelectOption(n);
    expect(opt.description).toContain("task");
  });
});

// ─── hijackExitMessage ────────────────────────────────────────────────────────

describe("hijackExitMessage", () => {
  it("returns 'exited ok' for code 0", () => {
    expect(hijackExitMessage(0)).toBe("exited ok");
  });

  it("returns code in message for non-zero exit", () => {
    expect(hijackExitMessage(1)).toBe("exited (code 1)");
    expect(hijackExitMessage(127)).toBe("exited (code 127)");
  });

  it("returns error message for null code", () => {
    expect(hijackExitMessage(null)).toBe("exited (error)");
  });
});

// ─── startHijackSession / killHijackChild (suspend/resume/cleanup) ─────────────

/**
 * Controllable fake child + renderer so the real suspend/spawn/cleanup lifecycle
 * is exercised without a TTY or a real agent process. The fake child carries NO
 * pid so killHijackChild takes the safe direct-`kill` path (never signals a real
 * process group).
 */
function makeFakeChild(): HijackChildLike & {
  fireClose: (code: number | null) => void;
  fireError: () => void;
  killed: () => number;
} {
  const handlers: { close?: (c: number | null) => void; error?: (e: unknown) => void } = {};
  let killCount = 0;
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  return {
    get exitCode() {
      return exitCode;
    },
    get signalCode() {
      return signalCode;
    },
    on(event: "close" | "error", listener: (arg: never) => void) {
      if (event === "close") handlers.close = listener as (c: number | null) => void;
      else handlers.error = listener as (e: unknown) => void;
      return this;
    },
    kill() {
      killCount += 1;
      signalCode = "SIGTERM";
      return true;
    },
    fireClose(code) {
      exitCode = code;
      handlers.close?.(code);
    },
    fireError() {
      handlers.error?.(new Error("spawn failed"));
    },
    killed: () => killCount,
  };
}

function makeFakeRenderer() {
  let suspend = 0;
  let resume = 0;
  return {
    renderer: {
      suspend() {
        suspend += 1;
      },
      resume() {
        resume += 1;
      },
    },
    suspends: () => suspend,
    resumes: () => resume,
  };
}

describe("startHijackSession", () => {
  it("suspends, spawns, then resumes + reports the exit code on close", () => {
    const r = makeFakeRenderer();
    const child = makeFakeChild();
    const codes: Array<number | null> = [];
    startHijackSession({
      renderer: r.renderer,
      spawnChild: () => child,
      onDone: (c) => codes.push(c),
    });
    expect(r.suspends()).toBe(1);
    expect(r.resumes()).toBe(0);

    child.fireClose(0);
    expect(codes).toEqual([0]);
    expect(r.resumes()).toBe(1);
  });

  it("cleanup kills the child and restores the renderer when unmounted mid-session", () => {
    const r = makeFakeRenderer();
    const child = makeFakeChild();
    const codes: Array<number | null> = [];
    const cleanup = startHijackSession({
      renderer: r.renderer,
      spawnChild: () => child,
      onDone: (c) => codes.push(c),
    });
    expect(child.killed()).toBe(0);

    cleanup();
    expect(child.killed()).toBe(1);
    expect(r.resumes()).toBe(1);
    // onDone only fires from the child's own close/error, not from cleanup.
    expect(codes).toEqual([]);
  });

  it("resumes the renderer EXACTLY once across close + later cleanup", () => {
    const r = makeFakeRenderer();
    const child = makeFakeChild();
    const cleanup = startHijackSession({
      renderer: r.renderer,
      spawnChild: () => child,
      onDone: () => {},
    });
    child.fireClose(0);
    cleanup();
    expect(r.resumes()).toBe(1);
  });

  it("resumes + reports null when the child errors", () => {
    const r = makeFakeRenderer();
    const child = makeFakeChild();
    const codes: Array<number | null> = [];
    startHijackSession({
      renderer: r.renderer,
      spawnChild: () => child,
      onDone: (c) => codes.push(c),
    });
    child.fireError();
    expect(codes).toEqual([null]);
    expect(r.resumes()).toBe(1);
  });

  it("resumes + reports null when spawn throws (never leaves the terminal suspended)", () => {
    const r = makeFakeRenderer();
    const codes: Array<number | null> = [];
    startHijackSession({
      renderer: r.renderer,
      spawnChild: () => {
        throw new Error("ENOENT");
      },
      onDone: (c) => codes.push(c),
    });
    expect(r.suspends()).toBe(1);
    expect(r.resumes()).toBe(1);
    expect(codes).toEqual([null]);
  });
});

describe("killHijackChild", () => {
  it("does nothing once the child has already exited", () => {
    const child = makeFakeChild();
    child.fireClose(0); // sets exitCode
    killHijackChild(child);
    expect(child.killed()).toBe(0);
  });

  it("kills a still-running child", () => {
    const child = makeFakeChild();
    killHijackChild(child);
    expect(child.killed()).toBe(1);
  });

  it("tolerates a null child", () => {
    expect(() => killHijackChild(null)).not.toThrow();
  });
});

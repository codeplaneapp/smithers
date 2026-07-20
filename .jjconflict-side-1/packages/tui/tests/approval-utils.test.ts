import { describe, it, expect } from "bun:test";
import {
  approvalModeOf,
  approvalOptionsOf,
  approvalOptionWindow,
  modeHasOptions,
  buildApprovalDecision,
  runApprovalSubmit,
  claimInFlight,
  releaseInFlight,
  approvalRowKey,
  selectNodeApproval,
  pruneResolvedKeys,
  routeApprovalKey,
  type InFlightRef,
} from "../src/modes/approvalUtils.ts";

describe("approvalModeOf", () => {
  it("passes through known modes", () => {
    expect(approvalModeOf("select")).toBe("select");
    expect(approvalModeOf("rank")).toBe("rank");
    expect(approvalModeOf("decision")).toBe("decision");
    expect(approvalModeOf("gate")).toBe("gate");
  });

  it("defaults unknown/missing to gate", () => {
    expect(approvalModeOf(undefined)).toBe("gate");
    expect(approvalModeOf("weird")).toBe("gate");
    expect(approvalModeOf(null)).toBe("gate");
  });
});

describe("modeHasOptions", () => {
  it("is true only for select and rank", () => {
    expect(modeHasOptions("select")).toBe(true);
    expect(modeHasOptions("rank")).toBe(true);
    expect(modeHasOptions("gate")).toBe(false);
    expect(modeHasOptions("decision")).toBe(false);
  });
});

describe("approvalOptionsOf", () => {
  it("normalizes {key,label} rows", () => {
    expect(approvalOptionsOf([{ key: "a", label: "A" }, { key: "b", label: "B" }])).toEqual([
      { key: "a", label: "A" },
      { key: "b", label: "B" },
    ]);
  });

  it("falls back label to key and drops keyless rows", () => {
    expect(approvalOptionsOf([{ key: "x" }, { label: "no key" }, "raw"])).toEqual([
      { key: "x", label: "x" },
      { key: "raw", label: "raw" },
    ]);
  });

  it("returns empty for non-arrays", () => {
    expect(approvalOptionsOf(undefined)).toEqual([]);
    expect(approvalOptionsOf("nope")).toEqual([]);
  });
});

describe("approvalOptionWindow", () => {
  it("shows all options with no indicator when the list fits", () => {
    expect(approvalOptionWindow(4, 2, 6)).toEqual({ start: 0, end: 4, hiddenCount: 0 });
    expect(approvalOptionWindow(6, 5, 6)).toEqual({ start: 0, end: 6, hiddenCount: 0 });
  });

  it("reserves one row for the indicator and follows the highlight past the fold", () => {
    // 8 options, 6 rows → 5 visible + indicator. Highlight on index 6 must be
    // inside the window (it used to walk invisible past row 6).
    const win = approvalOptionWindow(8, 6, 6);
    expect(win).toEqual({ start: 2, end: 7, hiddenCount: 3 });
    expect(6).toBeGreaterThanOrEqual(win.start);
    expect(6).toBeLessThan(win.end);
  });

  it("keeps the very last option reachable", () => {
    expect(approvalOptionWindow(8, 7, 6)).toEqual({ start: 3, end: 8, hiddenCount: 3 });
  });

  it("stays at the top while the highlight is inside the first window", () => {
    expect(approvalOptionWindow(8, 0, 6)).toEqual({ start: 0, end: 5, hiddenCount: 3 });
    expect(approvalOptionWindow(8, 4, 6)).toEqual({ start: 0, end: 5, hiddenCount: 3 });
  });

  it("always contains the selected index", () => {
    for (let sel = 0; sel < 12; sel++) {
      const { start, end } = approvalOptionWindow(12, sel, 6);
      expect(sel).toBeGreaterThanOrEqual(start);
      expect(sel).toBeLessThan(end);
    }
  });

  it("clamps out-of-range selections instead of overshooting", () => {
    expect(approvalOptionWindow(8, 99, 6)).toEqual({ start: 3, end: 8, hiddenCount: 3 });
    expect(approvalOptionWindow(8, -1, 6)).toEqual({ start: 0, end: 5, hiddenCount: 3 });
  });
});

describe("buildApprovalDecision", () => {
  const opts = [
    { key: "light", label: "Light" },
    { key: "balanced", label: "Balanced" },
  ];

  it("denies as a plain deny regardless of mode", () => {
    expect(buildApprovalDecision("select", false, opts, "light")).toEqual({ approved: false });
    expect(buildApprovalDecision("gate", false, [], null)).toEqual({ approved: false });
  });

  it("gate/decision approve carry no value", () => {
    expect(buildApprovalDecision("gate", true, [], null)).toEqual({ approved: true });
    expect(buildApprovalDecision("decision", true, [], null)).toEqual({ approved: true });
  });

  it("select approve nests { selected } under value", () => {
    expect(buildApprovalDecision("select", true, opts, "balanced")).toEqual({
      approved: true,
      value: { selected: "balanced" },
    });
  });

  it("select approve refuses an empty/unknown selection (returns null)", () => {
    expect(buildApprovalDecision("select", true, opts, null)).toBeNull();
    expect(buildApprovalDecision("select", true, opts, "ghost")).toBeNull();
  });

  it("rank approve nests { ranked } in listed order under value", () => {
    expect(buildApprovalDecision("rank", true, opts, null)).toEqual({
      approved: true,
      value: { ranked: ["light", "balanced"] },
    });
  });

  it("rank approve with no options returns null", () => {
    expect(buildApprovalDecision("rank", true, [], null)).toBeNull();
  });
});

describe("runApprovalSubmit", () => {
  it("refetches approvals ONLY on a successful submit, then settles", async () => {
    const order: string[] = [];
    await runApprovalSubmit({
      submit: async () => {
        order.push("submit");
      },
      onSuccess: () => order.push("success-refetch"),
      onError: () => order.push("error"),
      onSettled: () => order.push("settled"),
    });
    // refetch runs after submit resolves; no error; settle is last.
    expect(order).toEqual(["submit", "success-refetch", "settled"]);
  });

  it("routes a failed submit to onError (no refetch) and still settles", async () => {
    const order: string[] = [];
    let seenErr: unknown;
    await runApprovalSubmit({
      submit: async () => {
        throw new Error("gateway boom");
      },
      onSuccess: () => order.push("success-refetch"),
      onError: (err) => {
        seenErr = err;
        order.push("error");
      },
      onSettled: () => order.push("settled"),
    });
    expect(order).toEqual(["error", "settled"]);
    expect(seenErr).toBeInstanceOf(Error);
  });

  it("isolates a refetch failure so it is not reported as a submit error", async () => {
    const order: string[] = [];
    await runApprovalSubmit({
      submit: async () => order.push("submit"),
      onSuccess: () => {
        order.push("success-refetch");
        throw new Error("refetch failed");
      },
      onError: () => order.push("error"),
      onSettled: () => order.push("settled"),
    });
    // The thrown refetch error does NOT reach onError.
    expect(order).toEqual(["submit", "success-refetch", "settled"]);
  });
});

describe("in-flight dup-submit guard (claimInFlight / releaseInFlight)", () => {
  it("claims a free slot and rejects a second synchronous claim for the same key", () => {
    const ref: InFlightRef = { current: null };
    expect(claimInFlight(ref, "node-a:0")).toBe(true);
    // Same-tick second press for the SAME pending request is dropped.
    expect(claimInFlight(ref, "node-a:0")).toBe(false);
  });

  it("only blocks the SAME key; a different request may take the slot", () => {
    // The TUI only ever has one focused/pending approval, so the guard is a
    // single slot: it rejects a duplicate of the in-flight key but lets a
    // genuinely different request (the user moved on) claim.
    const ref: InFlightRef = { current: null };
    expect(claimInFlight(ref, "node-a:0")).toBe(true);
    expect(claimInFlight(ref, "node-a:0")).toBe(false); // dup of in-flight key
    expect(claimInFlight(ref, "node-b:0")).toBe(true); // different request
  });

  it("re-allows the key only after it is released", () => {
    const ref: InFlightRef = { current: null };
    expect(claimInFlight(ref, "node-a:0")).toBe(true);
    releaseInFlight(ref, "node-a:0");
    expect(claimInFlight(ref, "node-a:0")).toBe(true);
  });

  it("release is a no-op when a different key holds the slot", () => {
    const ref: InFlightRef = { current: "node-a:0" };
    releaseInFlight(ref, "node-b:0");
    expect(ref.current).toBe("node-a:0");
  });

  it("two synchronous submits for one request fire exactly one RPC", async () => {
    // Mirror TreeMode.submitDecision's guard usage: claim BEFORE the promise,
    // release in onSettled. Two presses in the same tick → one submitApproval.
    const ref: InFlightRef = { current: null };
    let rpcCount = 0;
    const submitOnce = (key: string) => {
      if (!claimInFlight(ref, key)) return;
      void runApprovalSubmit({
        submit: async () => {
          rpcCount += 1;
        },
        onSuccess: () => {},
        onError: () => {},
        onSettled: () => releaseInFlight(ref, key),
      });
    };
    // Both calls happen synchronously, before any promise settles.
    submitOnce("node-a:0");
    submitOnce("node-a:0");
    await new Promise((r) => setTimeout(r, 0));
    expect(rpcCount).toBe(1);
  });
});

describe("approvalRowKey", () => {
  it("builds the `${nodeId}:${iteration}` identity", () => {
    expect(approvalRowKey({ nodeId: "n", iteration: 2 })).toBe("n:2");
  });
  it("renders a missing iteration as `undefined` (container nodes)", () => {
    expect(approvalRowKey({ nodeId: "n" })).toBe("n:undefined");
  });
});

describe("selectNodeApproval", () => {
  const rows = [
    { nodeId: "loop", iteration: 0, requestTitle: "first" },
    { nodeId: "loop", iteration: 1, requestTitle: "second" },
    { nodeId: "container" }, // no iteration
  ];

  it("returns undefined when no node is focused", () => {
    expect(selectNodeApproval(rows, null)).toBeUndefined();
  });

  it("matches by node id AND iteration so each loop attempt resolves its own row", () => {
    expect(selectNodeApproval(rows, { id: "loop", iteration: 1 })?.requestTitle).toBe("second");
    expect(selectNodeApproval(rows, { id: "loop", iteration: 0 })?.requestTitle).toBe("first");
  });

  it("falls back to id-only for container nodes (no iteration in view)", () => {
    expect(selectNodeApproval(rows, { id: "container" })?.nodeId).toBe("container");
  });

  it("suppresses a row whose key is in resolvedKeys", () => {
    const resolved = new Set(["loop:1"]);
    // The decided attempt is hidden; its sibling attempt is unaffected.
    expect(selectNodeApproval(rows, { id: "loop", iteration: 1 }, resolved)).toBeUndefined();
    expect(selectNodeApproval(rows, { id: "loop", iteration: 0 }, resolved)?.requestTitle).toBe("first");
  });
});

describe("pruneResolvedKeys", () => {
  it("returns the SAME set when empty (state updater bails out)", () => {
    const empty = new Set<string>();
    expect(pruneResolvedKeys(empty, [{ nodeId: "a", iteration: 0 }])).toBe(empty);
  });

  it("returns the SAME set when every resolved key is still pending", () => {
    const resolved = new Set(["a:0"]);
    expect(pruneResolvedKeys(resolved, [{ nodeId: "a", iteration: 0 }])).toBe(resolved);
  });

  it("drops resolved keys once their row leaves the pending set", () => {
    const resolved = new Set(["a:0", "b:1"]);
    const next = pruneResolvedKeys(resolved, [{ nodeId: "b", iteration: 1 }]);
    expect(next).not.toBe(resolved);
    expect([...next]).toEqual(["b:1"]);
  });
});

describe("routeApprovalKey (pane-independent banner controls)", () => {
  const ctx = { hasApproval: true, isHumanRequest: false, mode: "gate" as const, busy: false };

  it("routes `a`/`d` to approve/deny — these fire in ANY pane (#1)", () => {
    // The router takes no pane argument: the same key yields the same action
    // whether focus is in the tree or the inspector, which is exactly why the
    // banner's a/d keep working after Tab/Enter moves focus into the inspector.
    expect(routeApprovalKey("a", ctx)).toEqual({ kind: "approve" });
    expect(routeApprovalKey("d", ctx)).toEqual({ kind: "deny" });
  });

  it("normalizes single-character approval keys from terminal input", () => {
    expect(routeApprovalKey("A", ctx)).toEqual({ kind: "approve" });
    expect(routeApprovalKey("D", ctx)).toEqual({ kind: "deny" });
  });

  it("routes `[`/`]` to option cycling only in select mode", () => {
    const select = { ...ctx, mode: "select" as const };
    expect(routeApprovalKey("]", select)).toEqual({ kind: "cycle", dir: 1 });
    expect(routeApprovalKey("[", select)).toEqual({ kind: "cycle", dir: -1 });
    // gate/rank have no per-option pick.
    expect(routeApprovalKey("]", ctx)).toBeNull();
    expect(routeApprovalKey("]", { ...ctx, mode: "rank" })).toBeNull();
  });

  it("ignores approval keys when there is no pending approval", () => {
    expect(routeApprovalKey("a", { ...ctx, hasApproval: false })).toBeNull();
  });

  it("ignores a/d for a human request (resolved only via the CLI)", () => {
    expect(routeApprovalKey("a", { ...ctx, isHumanRequest: true })).toBeNull();
  });

  it("ignores a/d while a submit is already in flight (busy)", () => {
    expect(routeApprovalKey("a", { ...ctx, busy: true })).toBeNull();
    // …but option cycling still works during a busy gate? No — cycle is select-only
    // and busy only blocks submit; a select cycle is allowed while busy.
    expect(routeApprovalKey("]", { ...ctx, mode: "select", busy: true })).toEqual({ kind: "cycle", dir: 1 });
  });

  it("ignores unrelated keys", () => {
    expect(routeApprovalKey("j", ctx)).toBeNull();
  });
});

describe("approval submit then immediate re-press issues no second RPC (#2)", () => {
  it("synchronous resolved-key suppression hides the decided row before refetch", async () => {
    // End-to-end of the helper logic TreeMode composes: a successful submit marks
    // the row resolved (synchronously, in onSuccess) so the very next keypress —
    // routed through selectNodeApproval + routeApprovalKey — sees no active
    // approval and fires no second submitApproval, even though the in-flight
    // guard already released in onSettled and the refetch hasn't landed.
    const focusedNode = { id: "gate", iteration: 0 };
    const approvals = [{ nodeId: "gate", iteration: 0, requestTitle: "ship?" }];
    let resolvedKeys: ReadonlySet<string> = new Set();
    const inFlight: InFlightRef = { current: null };
    let rpcCount = 0;

    const pressApprove = async () => {
      const active = selectNodeApproval(approvals, focusedNode, resolvedKeys);
      const action = routeApprovalKey("a", {
        hasApproval: active !== undefined,
        isHumanRequest: false,
        mode: "gate",
        busy: false,
      });
      if (!action || action.kind !== "approve" || !active) return;
      const key = approvalRowKey(active);
      if (!claimInFlight(inFlight, key)) return;
      await runApprovalSubmit({
        submit: async () => {
          rpcCount += 1;
        },
        // Mirror TreeMode: mark resolved synchronously on success (NO refetch
        // here — the stale row stays in `approvals` to prove suppression).
        onSuccess: () => {
          const next = new Set(resolvedKeys);
          next.add(key);
          resolvedKeys = next;
        },
        onError: () => {},
        onSettled: () => releaseInFlight(inFlight, key),
      });
    };

    await pressApprove(); // succeeds → row marked resolved
    expect(rpcCount).toBe(1);
    await pressApprove(); // immediate re-press: suppressed, no second RPC
    expect(rpcCount).toBe(1);
  });
});

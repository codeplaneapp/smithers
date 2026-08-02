// Edge-path coverage for the extension hooks: disabled/no-op branches, the
// error catch, and the abort-race guards in the stream reconnect loop. These
// mechanics use narrow injected clients — the established pattern in this
// package's extension-hooks test for driving pure hook logic.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

import { describe, expect, test } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SmithersGatewayClient } from "@smthrs/gateway-client";
import { SmithersGatewayProvider, useGatewayExtensionResource, useGatewayExtensionStream } from "../src/index.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Harness = {
  render: (element: ReactElement) => Promise<void>;
  unmount: () => Promise<void>;
};

async function mountHarness(): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
  });
  return {
    render: async (element) => {
      await act(async () => {
        root.render(element);
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("useGatewayExtensionResource — disabled + error paths", () => {
  test("disabled hook clears state, refetch() is a no-op, and never calls the client", async () => {
    let calls = 0;
    const client = {
      extensionRpc: async () => {
        calls += 1;
        return { ok: true };
      },
    } as unknown as SmithersGatewayClient;

    let snapshot: ReturnType<typeof useGatewayExtensionResource> | undefined;
    function Probe() {
      snapshot = useGatewayExtensionResource("github", "issue", { id: "1" }, { enabled: false });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(createElement(SmithersGatewayProvider, { client }, createElement(Probe)));
    await act(async () => {
      await Promise.resolve();
    });

    // The disabled effect branch cleared state; no fetch was issued.
    expect(snapshot?.loading).toBe(false);
    expect(snapshot?.data).toBeUndefined();
    expect(snapshot?.error).toBeUndefined();
    expect(calls).toBe(0);

    // refetch() short-circuits while disabled.
    await act(async () => {
      await snapshot?.refetch();
    });
    expect(calls).toBe(0);

    await harness.unmount();
  });

  test("a rejecting extensionRpc surfaces the error and clears loading", async () => {
    const client = {
      extensionRpc: async () => {
        throw new Error("extension blew up");
      },
    } as unknown as SmithersGatewayClient;

    let snapshot: ReturnType<typeof useGatewayExtensionResource> | undefined;
    function Probe() {
      snapshot = useGatewayExtensionResource("github", "issue", { id: "1" });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(createElement(SmithersGatewayProvider, { client }, createElement(Probe)));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(snapshot?.error).toBeInstanceOf(Error);
    expect(snapshot?.error?.message).toBe("extension blew up");
    expect(snapshot?.loading).toBe(false);
    expect(snapshot?.data).toBeUndefined();

    await harness.unmount();
  });

  test("a non-Error rejection is wrapped into an Error", async () => {
    const client = {
      extensionRpc: async () => {
        // eslint-disable-next-line no-throw-literal
        throw "string failure";
      },
    } as unknown as SmithersGatewayClient;

    let snapshot: ReturnType<typeof useGatewayExtensionResource> | undefined;
    function Probe() {
      snapshot = useGatewayExtensionResource("ns", "key");
      return null;
    }

    const harness = await mountHarness();
    await harness.render(createElement(SmithersGatewayProvider, { client }, createElement(Probe)));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(snapshot?.error).toBeInstanceOf(Error);
    expect(snapshot?.error?.message).toBe("string failure");

    await harness.unmount();
  });
});

describe("useGatewayExtensionStream — disabled + abort-race guards", () => {
  test("an explicitly disabled stream never subscribes and reports not-streaming", async () => {
    let subscribed = 0;
    const client = {
      streamExtension: async function* () {
        subscribed += 1;
        await new Promise(() => {});
      },
    } as unknown as SmithersGatewayClient;

    let snapshot: ReturnType<typeof useGatewayExtensionStream> | undefined;
    function Probe() {
      snapshot = useGatewayExtensionStream("logs", "tail", {}, { enabled: false });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(createElement(SmithersGatewayProvider, { client }, createElement(Probe)));
    await act(async () => {
      await Promise.resolve();
    });

    expect(subscribed).toBe(0);
    expect(snapshot?.streaming).toBe(false);

    await harness.unmount();
  });

  test("a missing namespace/key skips the subscription", async () => {
    let subscribed = 0;
    const client = {
      streamExtension: async function* () {
        subscribed += 1;
        await new Promise(() => {});
      },
    } as unknown as SmithersGatewayClient;

    let snapshot: ReturnType<typeof useGatewayExtensionStream> | undefined;
    function Probe() {
      snapshot = useGatewayExtensionStream(undefined, undefined);
      return null;
    }

    const harness = await mountHarness();
    await harness.render(createElement(SmithersGatewayProvider, { client }, createElement(Probe)));
    await act(async () => {
      await Promise.resolve();
    });

    expect(subscribed).toBe(0);
    expect(snapshot?.streaming).toBe(false);

    await harness.unmount();
  });

  test("an error that arrives AFTER unmount is dropped (aborted-in-catch guard)", async () => {
    // The generator yields one frame, then suspends on a promise the test
    // controls. We unmount (which aborts) BEFORE releasing that promise, then
    // release it so the generator throws while the abort flag is already set —
    // exercising the `if (abort.signal.aborted) return` guard in the catch.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sawSecondSubscribe = false;
    async function* gen() {
      yield { seq: 1 };
      await gate;
      throw new Error("late throw after abort");
    }
    const client = {
      streamExtension: () => {
        if (sawSecondSubscribe) throw new Error("should not resubscribe after aborted throw");
        return gen();
      },
    } as unknown as SmithersGatewayClient;

    function Probe() {
      useGatewayExtensionStream("logs", "tail", {}, { backoff: { baseMs: 0, maxMs: 0, jitter: 0 } });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(createElement(SmithersGatewayProvider, { client }, createElement(Probe)));
    // Let the first frame land and the generator suspend on the gate.
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
    // Unmount aborts the controller while the generator is suspended.
    sawSecondSubscribe = true;
    await harness.unmount();
    // Release the gate: the generator throws, but abort is already set, so the
    // loop returns from the catch without setting error state or resubscribing.
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 5));
    });
  });

  test("a normal generator end AFTER unmount returns before the backoff wait (aborted-post-catch guard)", async () => {
    // The generator yields one frame then suspends; we unmount (abort) then let
    // it END normally. The loop must hit `if (abort.signal.aborted) return`
    // AFTER the try/for-await completes, before scheduling a reconnect.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let subscribeCount = 0;
    async function* gen() {
      subscribeCount += 1;
      yield { seq: 1 };
      await gate;
      // ends normally (no throw) → for-await completes
    }
    const client = {
      streamExtension: () => gen(),
    } as unknown as SmithersGatewayClient;

    function Probe() {
      useGatewayExtensionStream("logs", "tail", {}, { backoff: { baseMs: 1000, maxMs: 1000, jitter: 0 } });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(createElement(SmithersGatewayProvider, { client }, createElement(Probe)));
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
    await harness.unmount();
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 5));
    });
    // No reconnect happened (the post-catch abort guard returned first).
    expect(subscribeCount).toBe(1);
  });
});

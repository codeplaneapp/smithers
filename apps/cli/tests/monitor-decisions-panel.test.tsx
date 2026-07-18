/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

const nativeFetch = globalThis.fetch;
const previousReactActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { DecisionsPanel } = await import("../src/monitor-ui/monitorDecisions.tsx");
let container: HTMLElement | undefined;
let root: import("react-dom/client").Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  globalThis.fetch = nativeFetch;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
  if (previousReactActEnvironment === undefined) delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  else (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousReactActEnvironment;
});

async function render(fetchImpl: typeof fetch, onSelectNode = (_node: { id: string; key: string; iteration?: number }) => {}) {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  globalThis.fetch = fetchImpl;
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<DecisionsPanel runId="run-1" runStatus="finished" onSelectNode={onSelectNode} />));
  await act(async () => { await Promise.resolve(); });
}
const response = (data: unknown) => ({ ok: true, json: async () => data }) as Response;

describe("DecisionsPanel", () => {
  test("decodes the REST envelope, renders decisions, and selects the entry node", async () => {
    let selected: { id: string; key: string; iteration?: number } | undefined;
    await render(async () => response({ ok: true, data: { entries: [
      { kind: "memory", title: "late", status: "recorded", occurredAtMs: 20, detail: { value: true } },
      { kind: "approval", nodeId: "gate", iteration: 2, title: "Ship?", status: "pending", occurredAtMs: 10, detail: {} },
      { kind: "ask-human", nodeId: "ask", title: "Continue?", status: "answered", occurredAtMs: 30, resolution: { by: "cli", value: "yes, canary first" }, detail: {} },
    ] } }), (node) => { selected = node; });
    expect(container?.textContent).toContain("1 pending");
    // The answer itself must be on the visible line, not hidden under Details.
    expect(container?.textContent).toContain("answered by cli — yes, canary first");
    expect(container?.querySelector(".mon-pill")?.classList.contains("tone-waiting")).toBe(true);
    expect(container?.textContent?.indexOf("Ship?")).toBeLessThan(container?.textContent?.indexOf("late") ?? 0);
    (container?.querySelector("button.mon-toggle") as HTMLButtonElement).click();
    expect(selected).toEqual({ id: "gate", key: "gate", iteration: 2 });
  });

  test("renders empty and fetch-failure states without crashing", async () => {
    await render(async () => response({ ok: true, data: { entries: [] } }));
    expect(container?.textContent).toContain("No decisions recorded for this run");
    await render(async () => { throw new Error("offline"); });
    expect(container?.textContent).toContain("Couldn’t load decisions");
  });
});

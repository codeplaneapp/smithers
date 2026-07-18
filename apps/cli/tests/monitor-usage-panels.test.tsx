/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

const nativeFetch = globalThis.fetch;
const previousReactActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { RunCostCard, AccountUsageCards } = await import("../src/monitor-ui/monitorUsagePanels.tsx");
let root: import("react-dom/client").Root | undefined;
let container: HTMLElement | undefined;
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined; container?.remove(); container = undefined; });
afterAll(async () => {
  globalThis.fetch = nativeFetch;
  if (previousReactActEnvironment === undefined) delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  else (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousReactActEnvironment;
  await GlobalRegistrator.unregister();
});
async function render(element: import("react").ReactElement) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); await act(async () => root?.render(element)); }

test("run cost card consumes the real {ok,data} gateway envelope and renders models/projection", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, data: { totals: { tokens: 1000, costUsd: 1.25 }, groups: [{ engine: "codex", model: "gpt-5.6-luna", tokens: 1000, costUsd: 1.25, priced: true }], buckets: [{ startMs: Date.now() - 20_000, tokens: 100 }] } }), { status: 200 });
  await render(<RunCostCard runId="r1" active progressRatio={.5} />);
  expect(container?.textContent).toContain("$1.25");
  expect(container?.textContent).toContain("codex · gpt-5.6-luna");
  expect(container?.textContent).toContain("1.0K tokens · 100/min · ~2.0K projected");
});

test("account cards consume envelope and retain visible cached window labels", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, data: [{ accountLabel: "work", stale: true, windows: [{ label: "five hour", usedPercent: 85, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] }] }), { status: 200 });
  await render(<AccountUsageCards />);
  expect(container?.textContent).toContain("work · five hour");
  expect(container?.textContent).toContain("85%");
  expect(container?.textContent).toMatch(/reset in (59|60)m/);
  expect(container?.textContent).toContain("cached");
});

test("account cards explain reports with no windows", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, data: [{ accountLabel: "work", windows: [] }] }), { status: 200 });
  await render(<AccountUsageCards />);
  expect(container?.textContent).toContain("no subscription windows reported");
});

test("account cards do not render a missing percentage as zero usage", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, data: [{ accountLabel: "work", windows: [{ label: "weekly", usedPercent: null }] }] }), { status: 200 });
  await render(<AccountUsageCards />);
  expect(container?.textContent).toContain("—");
  expect(container?.textContent).not.toContain("0%");
});

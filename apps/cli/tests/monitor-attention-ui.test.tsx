/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

const nativeFetch = globalThis.fetch;
const previousReactActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
GlobalRegistrator.register();
globalThis.fetch = nativeFetch;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AttentionBannerView } = await import("../src/monitor-ui/monitorAttentionBanner.tsx");
const { FailedTaskBadge } = await import("../src/monitor-ui/monitorFailedBadge.tsx");
const { RunRailRow } = await import("../src/monitor-ui/monitorRunRailRow.tsx");
const { RunsTableRow } = await import("../src/monitor-ui/monitorRunsTableRow.tsx");
let host: HTMLElement | undefined; let root: ReturnType<typeof createRoot> | undefined;
async function render(node: import("react").ReactElement) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root?.render(node)); }
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined; host?.remove(); host = undefined; });
afterAll(async () => {
  await GlobalRegistrator.unregister();
  globalThis.fetch = nativeFetch;
  if (previousReactActEnvironment === undefined) delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  else (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousReactActEnvironment;
});

test("attention banner renders actionable quota attention and hides when empty", async () => {
  let selected = "";
  await render(<AttentionBannerView items={[{ kind: "quota", tone: "warn", runId: "run-12345678", headline: "Waiting for quota", resetAtMs: Date.now() + 60_000 }]} total={1} onSelectRun={(id) => { selected = id; }} />);
  expect(host?.querySelector('[data-testid="monitor-attention"]')?.textContent).toContain("Waiting for quota");
  expect(host?.querySelector("button")?.className).toContain("tone-warn");
  await act(async () => (host?.querySelector("button") as HTMLButtonElement).click()); expect(selected).toBe("run-12345678");
  await act(async () => root?.render(<AttentionBannerView items={[]} total={0} onSelectRun={() => {}} />)); expect(host?.querySelector('[data-testid="monitor-attention"]')).toBeNull();
});

test("attention banner reports overflow beyond the rendered cap", async () => {
  await render(<AttentionBannerView items={[{ kind: "failed", tone: "crit", runId: "run-1", headline: "Run failed" }]} total={3} onSelectRun={() => {}} />);
  expect(host?.textContent).toContain("+2 more");
  expect(host?.querySelectorAll("button").length).toBe(1);
});

test("failed badges render in rail and table rows", async () => {
  let selected = "";
  await render(<div><FailedTaskBadge count={0} /><FailedTaskBadge count={2} /><RunRailRow runId="r" name="wf" title="wf" shortId="r" tone="failed" pulse={false} when={<>now</>} active={false} badge={<FailedTaskBadge count={1} />} onSelect={(id) => { selected = id; }} /><table><tbody><RunsTableRow run={{ runId: "table-run", status: "finished", summary: { failed: 2 } }} onSelect={(id) => { selected = id; }} /></tbody></table></div>);
  expect(host?.textContent).toContain("2 failed"); expect(host?.querySelectorAll(".mon-badge").length).toBe(3);
  await act(async () => (host?.querySelector('[data-run-id="table-run"]') as HTMLElement).click()); expect(selected).toBe("table-run");
});

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

test("attention banner groups repeats, caps rows crit-first, and hands the rest to View all", async () => {
  const failed = (runId: string, workflowKey: string, tone: "crit" | "warn" = "crit") =>
    ({ kind: "failed" as const, tone, runId, workflowKey, headline: "Run failed" });
  let viewedAll = 0;
  await render(
    <AttentionBannerView
      items={[
        failed("run-1", "implement"), failed("run-2", "implement"), failed("run-3", "implement"),
        failed("run-4", "review", "warn"),
        failed("run-5", "kanban"), failed("run-6", "trellis"), failed("run-7", "hello"), failed("run-8", "debug"),
      ]}
      total={157}
      onSelectRun={() => {}}
      onViewAll={() => { viewedAll++; }}
    />,
  );
  // (workflow, headline) groups digest into ≤4 quiet rows: ×N badge + headline
  // + short run ids — never one chip per run.
  const rows = [...(host?.querySelectorAll(".mon-attention-row") ?? [])];
  expect(rows.length).toBe(4);
  expect(rows[0]?.textContent).toContain("×3");
  expect(rows[0]?.textContent).toContain("implement — Run failed");
  expect(rows[0]?.textContent).toContain("+1");
  // Crit groups sort ahead of warn even when the warn item arrived earlier.
  expect(rows.every((row, index) => index === rows.length - 1 || !row.className.includes("tone-warn") || rows[index + 1]?.className.includes("tone-warn"))).toBe(true);
  const viewAll = host?.querySelector('[data-testid="monitor-attention-viewall"]') as HTMLButtonElement;
  expect(viewAll.textContent).toContain("View all 157");
  await act(async () => viewAll.click());
  expect(viewedAll).toBe(1);
});

test("failed badges render in rail and table rows", async () => {
  let selected = "";
  await render(<div><FailedTaskBadge count={0} /><FailedTaskBadge count={2} /><RunRailRow runId="r" name="wf" title="wf" shortId="r" tone="failed" pulse={false} when={<>now</>} active={false} badge={<FailedTaskBadge count={1} />} onSelect={(id) => { selected = id; }} /><table><tbody><RunsTableRow run={{ runId: "table-run", status: "finished", summary: { failed: 2 } }} onSelect={(id) => { selected = id; }} /></tbody></table></div>);
  // Two badges: the standalone count and the rail row's. The table row folds
  // its failed count into the Progress cell instead of a badge column.
  expect(host?.textContent).toContain("2 failed"); expect(host?.querySelectorAll(".mon-badge").length).toBe(2);
  expect(host?.querySelector(".mon-progress-failed")?.textContent).toContain("2 failed");
  await act(async () => (host?.querySelector('[data-run-id="table-run"]') as HTMLElement).click()); expect(selected).toBe("table-run");
});

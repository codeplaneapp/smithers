/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

const nativeFetch = globalThis.fetch;
const previousReactActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
GlobalRegistrator.register();
globalThis.fetch = nativeFetch;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { FootprintPanel } = await import("../src/monitor-ui/monitorFootprint.tsx");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  globalThis.fetch = nativeFetch;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
  globalThis.fetch = nativeFetch;
  if (previousReactActEnvironment === undefined) delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  else (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousReactActEnvironment;
});

async function render(fetchImpl: typeof fetch, onFocusNode = () => {}): Promise<void> {
  globalThis.fetch = fetchImpl;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<FootprintPanel runId="run" live={false} onFocusNode={onFocusNode} />));
  await act(async () => await Promise.resolve());
}

const payload = {
  ok: true,
  data: {
    filesChanged: 2,
    directories: [{ path: "src", files: 2, added: 5, removed: 1 }],
    files: [
      { path: "src/a.ts", added: 4, removed: 1, nodesTouched: 1, owner: { nodeId: "task", iteration: 2 } },
      { path: "src/b.ts", added: 1, removed: 0, nodesTouched: 1 },
    ],
    hottestDirectory: { path: "src", files: 2, added: 5, removed: 1 },
  },
};

test("renders a collapsed summary, expanded directory drill-down, and iteration focus chip", async () => {
  let focused = "";
  await render((async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch, (key) => { focused = key; });
  // The summary row has real anatomy: kicker + right-aligned ± rollup.
  const summary = container?.querySelector("summary");
  expect(summary?.querySelector(".mon-kicker")?.textContent).toBe("Footprint");
  expect(summary?.querySelector(".mon-footprint-rollup")?.textContent).toContain("2 files");
  expect(summary?.querySelector(".mon-footprint-plus")?.textContent).toBe("+5");
  expect(summary?.querySelector(".mon-footprint-minus")?.textContent).toBe("−1");
  const details = container?.querySelector("details") as HTMLDetailsElement;
  await act(async () => {
    details.open = true;
  });
  expect(container?.querySelector('[data-testid="footprint-directory"]')?.textContent).toContain("src+5 −1");
  expect(container?.querySelectorAll('[data-testid="footprint-file"]')).toHaveLength(2);
  const focusButton = container?.querySelector('[data-testid="footprint-node"]') as HTMLButtonElement;
  await act(async () => focusButton.click());
  expect(focused).toBe("task::2");
});

test("keeps the honest empty state when the API returns no changes", async () => {
  await render((async () => new Response(JSON.stringify({ ok: true, data: { filesChanged: 0, directories: [], files: [] } }), { status: 200 })) as typeof fetch);
  // Loaded-but-empty is the quiet row: kicker + dim status, no reserved void.
  const quiet = container?.querySelector('[data-testid="footprint-panel"]');
  expect(quiet?.classList.contains("mon-panel-quiet")).toBe(true);
  expect(quiet?.querySelector(".mon-kicker")?.textContent).toBe("Footprint");
  expect(quiet?.textContent).toContain("no changes yet");
});

test("does not claim to retain data when the first fetch fails", async () => {
  await render((async () => { throw new Error("offline"); }) as typeof fetch);
  expect(container?.querySelector('[data-testid="footprint-summary"]')?.textContent).toBe("footprint unavailable");
  expect(container?.querySelector('[data-testid="footprint-degraded"]')).toBeNull();
});

test("every mon-footprint-* class the panel renders is defined in the monitor stylesheet", async () => {
  const { monitorCss } = await import("../src/monitor-ui/monitorCss.ts");
  await render((async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch);
  const used = new Set<string>();
  container?.querySelectorAll("[class]").forEach((element) => {
    for (const cls of element.classList) if (cls.startsWith("mon-footprint-")) used.add(cls);
  });
  expect([...used].sort()).toEqual([
    "mon-footprint-added",
    "mon-footprint-bar",
    "mon-footprint-counts",
    "mon-footprint-directory",
    "mon-footprint-file",
    "mon-footprint-minus",
    "mon-footprint-name",
    "mon-footprint-owner",
    "mon-footprint-panel",
    "mon-footprint-plus",
    "mon-footprint-removed",
    "mon-footprint-rollup",
  ]);
  for (const cls of used) expect(monitorCss).toContain(`.${cls}`);
});

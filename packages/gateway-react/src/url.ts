/** URL helpers for gateway-served workflow UIs. All SSR-safe. */

function locationSearch(): string {
  if (typeof window !== "undefined" && window.location) return window.location.search;
  if (typeof location !== "undefined") return location.search;
  return "";
}

/** Read one query param from the current page URL; undefined when absent or SSR. */
export function paramFromUrl(name: string): string | undefined {
  const search = locationSearch();
  if (!search) return undefined;
  return new URLSearchParams(search).get(name) ?? undefined;
}

export function runIdFromUrl(): string | undefined {
  return paramFromUrl("runId");
}

/**
 * Same-origin href to a sibling workflow's run UI (served by the same gateway).
 * `pathname` defaults to the current page path; pass it explicitly in tests or
 * SSR. Returns the href even in SSR when a pathname is provided.
 */
export function workflowUiHref(workflowKey: string, runId: string, pathname?: string): string {
  const from = pathname ?? (typeof window !== "undefined" ? window.location.pathname : "");
  const base = from.replace(/\/workflows\/[^/]*$/, "");
  return `${base}/workflows/${encodeURIComponent(workflowKey)}?runId=${encodeURIComponent(runId)}`;
}

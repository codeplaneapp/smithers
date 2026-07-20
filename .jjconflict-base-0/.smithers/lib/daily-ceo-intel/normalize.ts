import type { CeoIntelDb } from "./db";
import { recordFetchHistory } from "./db";
import type { CoverageRow, FetchSourceRow, Item, NormalizeOutput } from "./schemas";

const DATE_UNCERTAIN_SAMPLE_LIMIT = 20;

export function normalize(
  fetchResults: FetchSourceRow[][],
  criticalSourceIds: string[],
  db: CeoIntelDb,
  runAt: string,
): NormalizeOutput {
  const allSourceRows = fetchResults.flat();
  const coverage: CoverageRow[] = allSourceRows.map(({ items: _items, ...row }) => row);
  const items: Item[] = allSourceRows.flatMap((row) => row.items);

  const dateUncertainItems = items.filter((item) => item.dateUncertain);
  const dateUncertainSample = dateUncertainItems.slice(0, DATE_UNCERTAIN_SAMPLE_LIMIT).map((item) => ({
    sourceId: item.sourceId,
    title: item.title,
    url: item.url,
  }));

  const degraded = coverage.some((row) => !row.ok);
  const criticalFailed = coverage.some((row) => !row.ok && criticalSourceIds.includes(row.sourceId));

  recordFetchHistory(db, runAt, coverage);

  const failedSummary = coverage.filter((row) => !row.ok).map((row) => row.sourceId);
  return {
    itemCount: items.length,
    dateUncertainCount: dateUncertainItems.length,
    coverage,
    degraded,
    criticalFailed,
    items,
    dateUncertainSample,
    summary:
      `Normalized ${items.length} items from ${coverage.length} sources` +
      (failedSummary.length ? `; failed: ${failedSummary.join(", ")}` : "") +
      (criticalFailed ? " (CRITICAL source failure)" : "") +
      ".",
  };
}

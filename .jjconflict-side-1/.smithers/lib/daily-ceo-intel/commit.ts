import { contentHashKey } from "./dedupe";
import type { CeoIntelDb } from "./db";
import { pruneFingerprints, upsertFingerprint, upsertSeenUrl } from "./db";
import { fingerprintFor } from "./seen";
import type { Cluster, CommitOutput } from "./schemas";

export function commitSeenState(
  clusters: Cluster[],
  db: CeoIntelDb,
  retentionDays: number,
  nowIso: string,
  shouldCommit: boolean,
  skipReasonIfNot: string | null,
): CommitOutput {
  if (!shouldCommit) {
    return {
      committed: false,
      fingerprintsAdded: 0,
      pruned: 0,
      skippedReason: skipReasonIfNot ?? "commit-seen-state was not eligible to run.",
      summary: `Seen-state not committed: ${skipReasonIfNot ?? "not eligible"}.`,
    };
  }

  for (const cluster of clusters) {
    const fingerprint = fingerprintFor(cluster.canonicalUrl);
    const contentHash = contentHashKey(cluster.excerpt || cluster.title);
    upsertFingerprint(db, fingerprint, cluster.srcId, cluster.canonicalUrl, contentHash, nowIso);
    upsertSeenUrl(db, cluster.canonicalUrl, nowIso);
  }
  const pruned = pruneFingerprints(db, retentionDays, nowIso);

  return {
    committed: true,
    fingerprintsAdded: clusters.length,
    pruned,
    skippedReason: null,
    summary: `Committed ${clusters.length} fingerprints; pruned ${pruned} past ${retentionDays}-day retention.`,
  };
}

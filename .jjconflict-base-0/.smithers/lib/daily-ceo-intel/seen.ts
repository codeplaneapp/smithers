import { createHash } from "node:crypto";
import { canonicalizeUrl, contentHashKey } from "./dedupe";
import type { CeoIntelDb } from "./db";
import { lookupFingerprint } from "./db";
import type { Item, SeenOutput } from "./schemas";

export function fingerprintFor(canonicalUrl: string): string {
  return createHash("sha1").update(canonicalUrl).digest("hex");
}

/** Read-only: checks fingerprints already committed by a prior run's commit-seen-state. */
export function removePreviouslySeen(items: Item[], db: CeoIntelDb): SeenOutput {
  let seenDropped = 0;
  let updatesFlagged = 0;
  const fresh: Item[] = [];

  for (const item of items) {
    const canonicalUrl = canonicalizeUrl(item.url);
    const fingerprint = fingerprintFor(canonicalUrl);
    const contentHash = contentHashKey(item.body || item.title);
    const existing = lookupFingerprint(db, fingerprint);
    if (!existing) {
      fresh.push(item);
      continue;
    }
    if (existing.contentHash === contentHash) {
      seenDropped += 1;
      continue;
    }
    updatesFlagged += 1;
    fresh.push({ ...item, isUpdate: true });
  }

  return {
    freshCount: fresh.length,
    seenDropped,
    updatesFlagged,
    items: fresh,
    summary: `${fresh.length} fresh stories (${updatesFlagged} flagged as updates to prior coverage); ${seenDropped} already seen in the last 30 days.`,
  };
}

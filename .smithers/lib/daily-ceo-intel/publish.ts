import type { CloudflareCreds } from "./cloudflare";
import { getKvValue, putKvValue } from "./cloudflare";
import type { CeoIntelDb } from "./db";
import { getDelivery, recordDelivery } from "./db";
import type { PublishOutput, RenderOutput } from "./schemas";

export async function publishIssue(
  render: RenderOutput,
  issueDateEt: string,
  cfCredsPresent: boolean,
  effectiveMode: "archive-only" | "publish",
  verifyPassed: boolean,
  criticalFailed: boolean,
  creds: CloudflareCreds | null,
  db: CeoIntelDb,
): Promise<PublishOutput> {
  if (!cfCredsPresent || effectiveMode !== "publish" || !verifyPassed || criticalFailed || !creds) {
    const skippedReason = !cfCredsPresent
      ? "Cloudflare credentials are not present in env."
      : effectiveMode !== "publish"
        ? "Effective publish mode is archive-only."
        : !verifyPassed
          ? "The composed issue failed verification."
          : "A critical source failed today.";
    return {
      attempted: false,
      published: false,
      idempotentSkip: false,
      skippedReason,
      kvKeys: [],
      deliveryId: null,
      summary: `Publish skipped: ${skippedReason}`,
    };
  }

  const existing = getDelivery(db, issueDateEt);
  if (existing) {
    return {
      attempted: true,
      published: true,
      idempotentSkip: true,
      skippedReason: "Already delivered for this issue date; KV writes skipped.",
      kvKeys: existing.kvKeys,
      deliveryId: existing.deliveryId,
      summary: `Issue ${issueDateEt} was already delivered (delivery ${existing.deliveryId}); skipped duplicate KV writes.`,
    };
  }

  try {
    const kvKeys = [`report:${issueDateEt}`, "latest"];
    await putKvValue(creds, `report:${issueDateEt}`, render.issueJson);
    // `latest` is a date pointer, not the Issue JSON itself (spec: "## Cloudflare
    // architecture (phase 2)") — the site resolves it by following the pointer to
    // `report:{date}`, so there's one source of truth per issue instead of two.
    await putKvValue(creds, "latest", issueDateEt);

    const indexRaw = await getKvValue(creds, "archive-index");
    const index: string[] = indexRaw ? (JSON.parse(indexRaw) as string[]) : [];
    if (!index.includes(issueDateEt)) {
      index.push(issueDateEt);
      index.sort();
      await putKvValue(creds, "archive-index", JSON.stringify(index));
      kvKeys.push("archive-index");
    }

    const deliveryId = crypto.randomUUID();
    recordDelivery(db, issueDateEt, new Date().toISOString(), kvKeys, deliveryId);
    return {
      attempted: true,
      published: true,
      idempotentSkip: false,
      skippedReason: null,
      kvKeys,
      deliveryId,
      summary: `Published ${issueDateEt} to Cloudflare KV (${kvKeys.join(", ")}).`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      attempted: true,
      published: false,
      idempotentSkip: false,
      skippedReason: `KV publish failed: ${message}`,
      kvKeys: [],
      deliveryId: null,
      summary: `Publish attempt failed: ${message}`,
    };
  }
}

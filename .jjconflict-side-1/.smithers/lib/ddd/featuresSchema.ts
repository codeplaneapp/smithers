import { z } from "zod/v4";

/**
 * Source-of-truth schema for .smithers/spec/features.json.
 *
 * The docs-driven-development spec is derived from this file, so the build
 * gate (`bun .smithers/lib/ddd/build.ts`) validates it. Keep this schema and
 * the `Feature` type rendered by the workflow UI in sync.
 */
export const featureStatusSchema = z.enum([
  "fixed",
  "partial",
  "broken",
  "missing-tests",
  "missing",
]);

export const featurePrioritySchema = z.enum(["p0", "p1", "p2"]);

/**
 * Tier organizes the spec into a two-level structure:
 *   - "feature"   : a top-level, end-user-facing product feature (the default).
 *   - "platform"  : an internal/infra concern that gates production confidence
 *                   but is not itself an end-user feature.
 *   - "reference" : a shared cross-cutting doc surfaced as a record so the UI
 *                   can link to it.
 */
export const featureTierSchema = z.enum(["feature", "platform", "reference"]);

/**
 * A link from a feature into a shared reference doc (or external URL). `href`
 * is either a content-root-relative path with an optional anchor
 * (e.g. "reference/architecture.md#engine") or a full URL.
 */
export const featureLinkSchema = z
  .object({
    label: z.string().min(1),
    href: z.string().min(1),
  })
  .strict();

/**
 * An API endpoint or command surface a feature depends on. `doc` deep-links
 * into a shared reference doc so the feature page and the catalog stay
 * cross-referenced.
 */
export const featureEndpointSchema = z
  .object({
    method: z.string().min(1),
    path: z.string().min(1),
    doc: z.string().optional(),
    note: z.string().optional(),
  })
  .strict();

/**
 * A drill-down capability of a top-level feature. Capabilities give
 * granularity without exploding the top-level list.
 */
export const featureCapabilitySchema = z
  .object({
    title: z.string().min(1),
    detail: z.string().min(1),
    status: featureStatusSchema.optional(),
  })
  .strict();

export const featureSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/, "id must be kebab-case (a-z, 0-9, -)"),
    title: z.string().min(1),
    summary: z.string().min(1),
    status: featureStatusSchema,
    priority: featurePrioritySchema,
    owner: z.string().min(1),
    // --- organization (optional; defaulted so existing records stay valid) ---
    tier: featureTierSchema.default("feature"),
    group: z.string().optional(),
    userValue: z.string().optional(),
    // --- drill-down + cross-linking ---
    capabilities: z.array(featureCapabilitySchema).default([]),
    endpoints: z.array(featureEndpointSchema).default([]),
    links: z.array(featureLinkSchema).default([]),
    // --- evidence ledger ---
    tests: z.array(z.string()).default([]),
    observability: z.array(z.string()).default([]),
    debug: z.array(z.string()).default([]),
    architecture: z.array(z.string()).default([]),
    changes: z.array(z.string()).default([]),
    diffHints: z.array(z.string()).default([]),
    evidence: z.array(z.string()).optional(),
    missing: z.array(z.string()).default([]),
  })
  .strict();

export const featuresSchema = z.array(featureSchema);

export type FeatureStatus = z.infer<typeof featureStatusSchema>;
export type FeatureTier = z.infer<typeof featureTierSchema>;
export type FeatureLink = z.infer<typeof featureLinkSchema>;
export type FeatureEndpoint = z.infer<typeof featureEndpointSchema>;
export type FeatureCapability = z.infer<typeof featureCapabilitySchema>;
export type Feature = z.infer<typeof featureSchema>;

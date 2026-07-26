/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  features,
  formatCount,
  formatFeatureTier,
  statusClass,
  statusLabels,
  type Feature,
  type FeatureStatus,
  type FeatureTier,
} from "./ddd-shared";

/**
 * The top-level product spec: end-user features first, grouped by journey, then
 * the platform and shared reference docs they link into. This is the entry point
 * Click a feature to drill into its capabilities, endpoints, and related docs.
 */
export type FeaturesTabProps = {
  onOpenFeature: (feature: Feature) => void;
};

const TIER_SECTIONS: { tier: string; label: string; blurb: string }[] = [
  {
    tier: "feature",
    label: "End-user features",
    blurb:
      "What people can do with the product, grouped by journey. Each links to the docs and endpoints it relies on.",
  },
  {
    tier: "platform",
    label: "Platform",
    blurb: "Infrastructure that gates production confidence rather than being a feature itself.",
  },
  {
    tier: "reference",
    label: "Reference",
    blurb: "Shared, cross-cutting docs (architecture, API catalog, backend services) that many features link into.",
  },
];

const STATUS_OPTIONS: Array<"all" | FeatureStatus> = ["all", "fixed", "partial", "broken", "missing-tests", "missing"];
const TIER_OPTIONS: Array<"all" | FeatureTier> = ["all", "feature", "platform", "reference"];

function tierOf(feature: Feature): string {
  return feature.tier ?? "feature";
}

function groupsInOrder(items: Feature[]): { group: string; items: Feature[] }[] {
  const order: string[] = [];
  const byGroup = new Map<string, Feature[]>();
  for (const feature of items) {
    const group = feature.group ?? "General";
    if (!byGroup.has(group)) {
      byGroup.set(group, []);
      order.push(group);
    }
    byGroup.get(group)!.push(feature);
  }
  return order.map((group) => ({ group, items: byGroup.get(group)! }));
}

function featureSearchBlob(feature: Feature): string {
  return [
    feature.id,
    feature.title,
    feature.summary,
    feature.userValue,
    feature.owner,
    feature.group,
    feature.priority,
    feature.status,
    ...(feature.capabilities ?? []).flatMap((cap) => [cap.title, cap.detail, cap.status ?? ""]),
    ...(feature.endpoints ?? []).flatMap((endpoint) => [
      endpoint.method,
      endpoint.path,
      endpoint.doc ?? "",
      endpoint.note ?? "",
    ]),
    ...(feature.links ?? []).flatMap((link) => [link.label, link.href]),
    ...(feature.tests ?? []),
    ...(feature.missing ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function FeaturesTab(props: FeaturesTabProps) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | FeatureStatus>("all");
  const [tierFilter, setTierFilter] = useState<"all" | FeatureTier>("all");
  const counts: Record<FeatureStatus, number> = { fixed: 0, partial: 0, broken: 0, "missing-tests": 0, missing: 0 };
  for (const feature of features) if (feature.status in counts) counts[feature.status] += 1;
  const filteredFeatures = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return features.filter((feature) => {
      if (statusFilter !== "all" && feature.status !== statusFilter) return false;
      if (tierFilter !== "all" && tierOf(feature) !== tierFilter) return false;
      return !needle || featureSearchBlob(feature).includes(needle);
    });
  }, [query, statusFilter, tierFilter]);
  const filtersActive = query.trim().length > 0 || statusFilter !== "all" || tierFilter !== "all";

  return (
    <div className="scroll pane" data-testid="ddd-features-tab">
      <section className="card">
        <div className="card-head">
          <h2>Product feature spec</h2>
          <span className="pill">
            {filteredFeatures.length === features.length
              ? formatCount(features.length, "feature")
              : `${formatCount(filteredFeatures.length, "feature")} of ${formatCount(features.length, "feature")}`}
          </span>
        </div>
        <p>
          The target product, top to bottom: every end-user feature, the platform it runs on, and the shared reference
          docs each feature links into. Click any feature to drill into its capabilities, API endpoints, and related
          docs.
        </p>
        <div className="filters" role="search" aria-label="Feature filters">
          <label className="filter-field">
            <span>Search</span>
            <input
              className="search-input"
              type="search"
              value={query}
              placeholder="Title, owner, path, capability"
              onInput={(event) => setQuery(event.currentTarget.value)}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <label className="filter-field">
            <span>Status</span>
            <select
              className="select"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.currentTarget.value as "all" | FeatureStatus)}
            >
              {STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {status === "all" ? "All statuses" : statusLabels[status]}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-field">
            <span>Kind</span>
            <select
              className="select"
              value={tierFilter}
              onChange={(event) => setTierFilter(event.currentTarget.value as "all" | FeatureTier)}
            >
              {TIER_OPTIONS.map((tier) => (
                <option key={tier} value={tier}>
                  {tier === "all" ? "All kinds" : formatFeatureTier(tier)}
                </option>
              ))}
            </select>
          </label>
          {filtersActive ? (
            <button
              className="button"
              type="button"
              onClick={() => {
                setQuery("");
                setStatusFilter("all");
                setTierFilter("all");
              }}
            >
              Clear
            </button>
          ) : null}
        </div>
        <div className="status-counts">
          {(Object.keys(counts) as FeatureStatus[])
            .filter((status) => counts[status] > 0)
            .map((status) => (
              <span key={status} className={`badge ${statusClass(status)}`}>
                {counts[status]} {statusLabels[status]}
              </span>
            ))}
        </div>
      </section>

      {TIER_SECTIONS.map((sec) => {
        const tierItems = filteredFeatures.filter((feature) => tierOf(feature) === sec.tier);
        if (tierItems.length === 0) return null;
        return (
          <section className="tier-section" key={sec.tier} data-testid={`ddd-tier-${sec.tier}`}>
            <div className="tier-head">
              <h2>{sec.label}</h2>
              <span className="pill">{formatCount(tierItems.length, "feature")}</span>
            </div>
            <p className="tier-blurb">{sec.blurb}</p>
            {groupsInOrder(tierItems).map((grp) => (
              <div className="group-block" key={grp.group}>
                <h3 className="group-title">{grp.group}</h3>
                <div className="feature-grid">
                  {grp.items.map((feature) => (
                    <button
                      className="feature-card is-clickable"
                      key={feature.id}
                      type="button"
                      data-testid="ddd-feature-card"
                      onClick={() => props.onOpenFeature(feature)}
                    >
                      <div className="feature-card-head">
                        <strong>{feature.title}</strong>
                        <span className={`badge ${statusClass(feature.status)}`}>
                          {statusLabels[feature.status] ?? feature.status}
                        </span>
                      </div>
                      <p className="feature-card-summary">{feature.userValue ?? feature.summary}</p>
                      <div className="feature-card-foot">
                        <span className="pill muted">P{feature.priority.replace(/^p/i, "")}</span>
                        {feature.capabilities?.length ? (
                          <span className="pill">
                            {formatCount(feature.capabilities.length, "capability", "capabilities")}
                          </span>
                        ) : null}
                        {feature.endpoints?.length ? (
                          <span className="pill">{formatCount(feature.endpoints.length, "endpoint")}</span>
                        ) : null}
                        {feature.links?.length ? (
                          <span className="pill">{formatCount(feature.links.length, "doc")}</span>
                        ) : null}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </section>
        );
      })}
      {filteredFeatures.length === 0 ? (
        <section className="card">
          <div className="empty">
            <h2>No matching features</h2>
            <p>Adjust the search or filters to see more of the product spec.</p>
          </div>
        </section>
      ) : null}
    </div>
  );
}

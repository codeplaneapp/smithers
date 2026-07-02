/** @jsxImportSource react */
import { features, statusClass, statusLabels, type Feature, type FeatureStatus } from "./ddd-shared";

/**
 * The top-level product spec: end-user features first, grouped by journey, then
 * the platform and shared reference docs they link into. This is the entry point
 * — click a feature to drill into its capabilities, endpoints, and related docs.
 */
export type FeaturesTabProps = {
  onOpenFeature: (feature: Feature) => void;
};

const TIER_SECTIONS: { tier: string; label: string; blurb: string }[] = [
  { tier: "feature", label: "End-user features", blurb: "What you can do with smithers — grouped by journey. Each links down to the shared docs and endpoints it relies on." },
  { tier: "platform", label: "Platform", blurb: "Infrastructure that gates production confidence rather than being a feature itself." },
  { tier: "reference", label: "Reference", blurb: "Shared, cross-cutting docs (architecture, API catalog, backend services) that many features link into." },
];

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

export function FeaturesTab(props: FeaturesTabProps) {
  const counts: Record<FeatureStatus, number> = { fixed: 0, partial: 0, broken: 0, "missing-tests": 0, missing: 0 };
  for (const feature of features) if (feature.status in counts) counts[feature.status] += 1;

  return (
    <div className="scroll pane" data-testid="ddd-features-tab">
      <section className="card">
        <div className="card-head">
          <h2>Smithers — product spec</h2>
          <span className="pill">{features.length} features</span>
        </div>
        <p>
          The smithers product, top to bottom: every end-user feature, the platform it runs on, and the
          shared reference docs each feature links into. Click any feature to drill into its capabilities,
          API endpoints, and related docs.
        </p>
        <div className="status-counts">
          {(Object.keys(counts) as FeatureStatus[]).map((status) => (
            <span key={status} className={`badge ${statusClass(status)}`}>{counts[status]} {statusLabels[status]}</span>
          ))}
        </div>
      </section>

      {TIER_SECTIONS.map((sec) => {
        const tierItems = features.filter((feature) => tierOf(feature) === sec.tier);
        if (tierItems.length === 0) return null;
        return (
          <section className="tier-section" key={sec.tier} data-testid={`ddd-tier-${sec.tier}`}>
            <div className="tier-head">
              <h2>{sec.label}</h2>
              <span className="pill">{tierItems.length}</span>
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
                        <span className={`badge ${statusClass(feature.status)}`}>{statusLabels[feature.status] ?? feature.status}</span>
                      </div>
                      <p>{feature.userValue ?? feature.summary}</p>
                      <div className="feature-card-foot">
                        <span className="pill muted">P{feature.priority.replace(/^p/i, "")}</span>
                        {feature.capabilities?.length ? <span className="pill">{feature.capabilities.length} capabilities</span> : null}
                        {feature.endpoints?.length ? <span className="pill">{feature.endpoints.length} endpoints</span> : null}
                        {feature.links?.length ? <span className="pill">{feature.links.length} docs</span> : null}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

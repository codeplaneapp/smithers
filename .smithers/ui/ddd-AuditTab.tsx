/** @jsxImportSource react */
import {
  OutputCard,
  formatStatus,
  features,
  findingLabels,
  statusClass,
  statusLabels,
  strings,
  type AuditFinding,
  type AuditRow,
  type Feature,
  type FeatureStatus,
} from "./ddd-shared";

export type AuditTabProps = {
  audit: AuditRow | null;
  bootstrap: Record<string, unknown> | null;
  spec: Record<string, unknown> | null;
  metaTicket: Record<string, unknown> | null;
  summary: Record<string, unknown> | null;
  triage: Array<{ slot: number; title: string; agent: string; reason: string; taskType: string }>;
  onOpenFeature: (feature: Feature, note?: string) => void;
};

function findingsOf(audit: AuditRow | null): AuditFinding[] {
  if (!audit) return [];
  const kinds: AuditFinding["kind"][] = ["broken", "partial", "missingE2E", "missingDocs"];
  return kinds.flatMap((kind) => {
    const raw =
      kind === "missingE2E"
        ? [...strings(audit.missingE2E), ...strings((audit as Record<string, unknown>).missing_e2e)]
        : kind === "missingDocs"
          ? [...strings(audit.missingDocs), ...strings((audit as Record<string, unknown>).missing_docs)]
          : strings(audit[kind]);
    return [...new Set(raw)].map((featureId) => ({ kind, featureId }));
  });
}

export function AuditTab(props: AuditTabProps) {
  const { audit, triage } = props;
  const findings = findingsOf(audit);
  const findingKindCounts = findings.reduce<Record<AuditFinding["kind"], number>>(
    (acc, finding) => {
      acc[finding.kind] = (acc[finding.kind] ?? 0) + 1;
      return acc;
    },
    { broken: 0, partial: 0, missingE2E: 0, missingDocs: 0 },
  );
  const notes = strings(audit?.notes);
  const bootstrapRow =
    props.bootstrap && props.bootstrap.docsBuildPassed === false && !props.bootstrap.status
      ? { ...props.bootstrap, status: "failed" }
      : props.bootstrap;
  const counts: Record<FeatureStatus, number> = { fixed: 0, partial: 0, broken: 0, "missing-tests": 0, missing: 0 };
  for (const feature of features) if (feature.status in counts) counts[feature.status] += 1;

  function openFeature(featureId: string) {
    const feature = features.find((item) => item.id === featureId);
    const note = notes.find((entry) => entry.includes(featureId));
    if (feature) props.onOpenFeature(feature, note);
  }

  function noteFor(featureId: string): string {
    return notes.find((entry) => entry.includes(featureId)) ?? "";
  }

  return (
    <div className="scroll pane" data-testid="ddd-audit-tab">
      <section className="card" data-testid="ddd-output-audit">
        <div className="card-head">
          <h2>Audit findings</h2>
          <span className={`badge ${audit ? "ok" : "muted"}`}>{formatStatus(audit ? "ready" : "waiting")}</span>
        </div>
        {findings.length ? (
          <div className="status-counts">
            {(Object.keys(findingKindCounts) as AuditFinding["kind"][])
              .filter((kind) => findingKindCounts[kind] > 0)
              .map((kind) => (
                <span key={kind} className={`badge ${statusClass(kind === "broken" ? "broken" : "partial")}`}>
                  {findingKindCounts[kind]} {findingLabels[kind]}
                </span>
              ))}
          </div>
        ) : null}
        {findings.length ? (
          findings.map((finding) => {
            const feature = features.find((item) => item.id === finding.featureId);
            if (!feature) {
              const note = noteFor(finding.featureId);
              return (
                <article
                  key={`${finding.kind}:${finding.featureId}`}
                  className="finding unresolved-finding"
                  data-testid="ddd-unresolved-finding"
                >
                  <div className="unresolved-finding-head">
                    <span className="fid">{finding.featureId}</span>
                    <span className={`badge ${statusClass(finding.kind === "broken" ? "broken" : "partial")}`}>
                      {findingLabels[finding.kind]}
                    </span>
                  </div>
                  <p>Audit returned an unknown feature id.</p>
                  {note ? (
                    <p>
                      <strong>Note:</strong> {note}
                    </p>
                  ) : null}
                  <p>
                    <strong>Next step:</strong> Add this feature to features.json or update the audit result to
                    reference an existing feature.
                  </p>
                </article>
              );
            }
            return (
              <button
                key={`${finding.kind}:${finding.featureId}`}
                type="button"
                className="finding"
                data-testid="ddd-finding"
                onClick={() => openFeature(finding.featureId)}
              >
                <span className="fid">{feature?.title ?? finding.featureId}</span>
                <span className={`badge ${statusClass(finding.kind === "broken" ? "broken" : "partial")}`}>
                  {findingLabels[finding.kind]}
                </span>
              </button>
            );
          })
        ) : (
          <p className="empty">No findings yet. Run the workflow (or dispatch from Specs) to populate the audit.</p>
        )}
      </section>

      <div className="grid2">
        <OutputCard label="Bootstrap" row={bootstrapRow} />
        <OutputCard label="Meta Ticket" row={props.metaTicket} pending="edit a spec and dispatch agents" />
        <OutputCard label="Spec Update" row={props.spec} />
        <OutputCard label="Final Summary" row={props.summary} pending="run the workflow to produce a summary" />
      </div>

      <section className="card" data-testid="ddd-output-triage">
        <div className="card-head">
          <h2>Triage slots</h2>
          <span className={`badge ${triage.length ? "ok" : "muted"}`}>{triage.length || formatStatus("waiting")}</span>
        </div>
        {triage.length ? (
          triage.map((item) => (
            <article className="slot" key={item.slot}>
              <div className="slot-title">
                <strong>
                  {item.slot}. {item.title}
                </strong>
                <span className="pill">{item.agent}</span>
              </div>
              <p>{item.reason}</p>
              <span className="pill">{item.taskType}</span>
            </article>
          ))
        ) : (
          <p className="empty">Start a run to populate the next implementation wave.</p>
        )}
      </section>

      <section className="card" data-testid="ddd-feature-matrix">
        <div className="card-head">
          <h2>Feature matrix</h2>
          <span className="pill">{features.length}</span>
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
        <div className="feature-grid">
          {features.map((feature) => (
            <article className="feature-card" key={feature.id}>
              <div className="feature-card-head">
                <strong>{feature.title}</strong>
                <span className={`badge ${statusClass(feature.status)}`}>
                  {statusLabels[feature.status] ?? feature.status}
                </span>
              </div>
              <p className="feature-card-summary">{feature.summary}</p>
              <button className="button" type="button" onClick={() => props.onOpenFeature(feature)}>
                Details
              </button>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

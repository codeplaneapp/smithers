import { useGatewayWorkflows } from "@smthrs/gateway-react";
import { Alert, AlertDescription, Badge, EmptyState, Skeleton } from "@smthrs/ui";
import "./crons.css";
import { describeCron, sortCrons, summarizeCrons, toneForCronEnabled, validateCreate } from "./crons";
import { useCronsStore } from "./cronsStore";

/**
 * The inline create form, shown at the top of the list when the store is
 * creating. A cron-pattern field and a workflow-KEY field (the gateway keys
 * crons by registered workflow KEY, e.g. `ralph`, NOT a file path), with the
 * derived validation message and a Create button gated on it being null. The key
 * field is backed by a `<datalist>` of the LIVE registry (`useGatewayWorkflows`)
 * so the user picks a real, registered key instead of guessing a path.
 */
function CreateForm() {
  const draftPattern = useCronsStore((state) => state.draftPattern);
  const draftWorkflowPath = useCronsStore((state) => state.draftWorkflowPath);
  const setDraftPattern = useCronsStore((state) => state.setDraftPattern);
  const setDraftWorkflowPath = useCronsStore((state) => state.setDraftWorkflowPath);
  const submitCreate = useCronsStore((state) => state.submitCreate);
  const cancelCreate = useCronsStore((state) => state.cancelCreate);

  // The live workflow registry: the gateway keys crons by these registered keys
  // (`row.key`), so we offer them as datalist options. Empty while the first
  // `listWorkflows` pull is in flight — the field stays a free-text input either
  // way, so a user can still type a key the datalist hasn't loaded.
  const { data: workflows } = useGatewayWorkflows();
  const workflowKeys = (workflows ?? [])
    .map((row) => row.key)
    .filter((key): key is string => typeof key === "string" && key.trim() !== "");
  const placeholderKey = workflowKeys[0] ?? "ralph";

  const message = validateCreate(draftPattern, draftWorkflowPath);
  // A required-field message reads as a warning; a syntactic failure reads as an
  // error. Both empty / one empty are the "required" messages.
  const isRequired =
    message === "Cron pattern and workflow key are required." ||
    message === "Cron pattern is required." ||
    message === "Workflow key is required.";

  return (
    <div className="rev-create" data-testid="crons-create">
      <div className="rev-create-head">Create trigger</div>
      <div className="crons-field-label">Cron Pattern</div>
      <input
        className="field-input is-mono"
        placeholder="e.g. 0 8 * * *"
        value={draftPattern}
        onChange={(event) => setDraftPattern(event.target.value)}
        data-testid="crons-create-pattern"
      />
      <div className="crons-field-label">Workflow Key</div>
      <input
        className="field-input is-mono"
        list="crons-workflow-keys"
        placeholder={`e.g. ${placeholderKey}`}
        value={draftWorkflowPath}
        onChange={(event) => setDraftWorkflowPath(event.target.value)}
        data-testid="crons-create-path"
      />
      <datalist id="crons-workflow-keys" data-testid="crons-workflow-keys">
        {workflowKeys.map((key) => (
          <option key={key} value={key} />
        ))}
      </datalist>
      {message ? (
        <div className={`crons-validation ${isRequired ? "is-warn" : "is-error"}`} data-testid="crons-validation">
          {message}
        </div>
      ) : null}
      <div className="rev-create-actions">
        <button
          className="btn btn-brand"
          type="button"
          onClick={submitCreate}
          disabled={message !== null}
          data-testid="crons-create-submit"
        >
          Create
        </button>
        <button className="btn" type="button" onClick={cancelCreate}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The detail-pane action area: Enable/Disable + Delete, or the delete-confirm strip. */
function DetailActions({ id }: { id: string }) {
  const cron = useCronsStore((state) => state.crons.find((c) => c.id === id) ?? null);
  const pendingDeleteId = useCronsStore((state) => state.pendingDeleteId);
  const toggle = useCronsStore((state) => state.toggle);
  const requestDelete = useCronsStore((state) => state.requestDelete);
  const cancelDelete = useCronsStore((state) => state.cancelDelete);
  const confirmDelete = useCronsStore((state) => state.confirmDelete);

  if (!cron) return null;

  if (pendingDeleteId === id) {
    return (
      <div className="crons-confirm" data-testid="crons-confirm">
        <span className="crons-confirm-text">Delete {cron.name}? This cannot be undone.</span>
        <button className="btn btn-deny" type="button" onClick={confirmDelete} data-testid="crons-confirm-delete">
          Delete
        </button>
        <button className="btn" type="button" onClick={cancelDelete}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="rev-detail-actions">
      <button className="btn" type="button" onClick={() => toggle(id)} data-testid="crons-toggle">
        {cron.enabled ? "Disable" : "Enable"}
      </button>
      <button className="btn btn-deny" type="button" onClick={() => requestDelete(id)} data-testid="crons-delete">
        Delete
      </button>
    </div>
  );
}

/** The full triggers surface: a trigger list on the left, trigger detail on the right. */
export function CronsCanvas() {
  const crons = useCronsStore((state) => state.crons);
  const loading = useCronsStore((state) => state.loading);
  const error = useCronsStore((state) => state.error);
  const creating = useCronsStore((state) => state.creating);
  const actionError = useCronsStore((state) => state.actionError);
  const openCreate = useCronsStore((state) => state.openCreate);
  const cancelCreate = useCronsStore((state) => state.cancelCreate);
  const refresh = useCronsStore((state) => state.refresh);
  const select = useCronsStore((state) => state.select);
  const dismissActionError = useCronsStore((state) => state.dismissActionError);
  const selected = useCronsStore((state) => state.crons.find((c) => c.id === state.selectedId) ?? null);

  const summary = summarizeCrons(crons);
  const ordered = sortCrons(crons);

  return (
    <section className="surface" data-testid="crons-canvas">
      <header className="surface-head">
        <span className="surface-title">Triggers</span>
        <span className="surface-sub">
          {summary.enabled} enabled · {summary.disabled} disabled · {summary.total} total
        </span>
        <div className="seg" data-testid="crons-toolbar" style={{ marginLeft: "auto" }}>
          <button
            type="button"
            className={creating ? "is-on" : ""}
            onClick={creating ? cancelCreate : openCreate}
            data-testid="crons-new-toggle"
          >
            {creating ? "Close" : "New"}
          </button>
          <button type="button" onClick={refresh} data-testid="crons-refresh">
            Refresh
          </button>
        </div>
      </header>

      {actionError ? (
        <Alert variant="destructive" className="crons-action-banner" data-testid="crons-action-banner">
          <AlertDescription>{actionError}</AlertDescription>
          <button className="btn" type="button" onClick={dismissActionError}>
            Dismiss
          </button>
        </Alert>
      ) : null}

      <div className="rev-body">
        <div className="rev-list">
          {creating ? <CreateForm /> : null}
          {loading && crons.length === 0 ? (
            <div role="status" data-testid="crons-loading">
              <Skeleton style={{ height: 54, margin: 12 }} />
              <span className="sui-sr-only">Loading cron triggers…</span>
            </div>
          ) : error && crons.length === 0 ? (
            <EmptyState title="Cron triggers unavailable" description={error} role="alert" />
          ) : ordered.length > 0 ? (
            ordered.map((cron) => (
              <button
                key={cron.id}
                type="button"
                className={selected?.id === cron.id ? "rev-row is-on" : "rev-row"}
                onClick={() => select(cron.id)}
                data-testid="crons-row"
              >
                <span className={`rev-dot ${toneForCronEnabled(cron.enabled)}`} />
                <div className="rev-row-main">
                  <div className="rev-row-title">{cron.name}</div>
                  <div className="rev-row-meta">
                    <code className="cron-pattern">{cron.pattern}</code>
                    <span>{cron.nextHint}</span>
                  </div>
                </div>
                <Badge variant={cron.enabled ? "success" : "muted"} data-status={cron.enabled ? "enabled" : "disabled"}>
                  {cron.enabled ? "ENABLED" : "DISABLED"}
                </Badge>
              </button>
            ))
          ) : (
            <EmptyState
              className="rev-empty"
              data-testid="crons-empty"
              title="No cron triggers found"
              description="Create one to schedule workflows."
            />
          )}
        </div>

        <div className="rev-detail">
          {selected ? (
            <div className="rev-detail-scroll">
              <div className="rev-detail-head">
                <div className="rev-detail-title">{selected.name}</div>
                <Badge
                  variant={selected.enabled ? "success" : "muted"}
                  data-status={selected.enabled ? "enabled" : "disabled"}
                >
                  {selected.enabled ? "ENABLED" : "DISABLED"}
                </Badge>
              </div>
              <div className="rev-row-meta">
                <code className="cron-pattern">{selected.pattern}</code>
                <span>{describeCron(selected.pattern)}</span>
              </div>
              <div className="rev-prose">{selected.workflowPath}</div>
              {selected.errorJson ? (
                <>
                  <div className="crons-error-json-label">Error JSON</div>
                  <pre className="crons-error-json" data-testid="crons-error-json">
                    {selected.errorJson}
                  </pre>
                </>
              ) : null}
              <DetailActions id={selected.id} />
            </div>
          ) : (
            <EmptyState className="rev-detail-empty" title="Select a trigger." />
          )}
        </div>
      </div>
    </section>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { StatusPill, WorkflowUiShell } from "smthrs/gateway-ui";
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState, KpiStat, StageStrip } from "smthrs/ui";

/**
 * The run surface embedded in the Live demo tab of custom-sandbox.smithers.sh.
 *
 * Every value on screen comes from the guard's projection of engine state.
 * Nothing is simulated: a status is the status the engine recorded, and the
 * Approve button posts a real decision that unblocks a parked run.
 *
 * The page hosting the iframe can drive it with postMessage
 * ({ type: "stereos-start", workflow }) and receives
 * { type: "stereos-state", ... } back, so the page-side buttons and this app
 * stay in sync.
 */

const WORKFLOWS = [
  { id: "hello", label: "hello", note: "One sandbox, one greeting built in the guest." },
  { id: "pipeline", label: "pipeline", note: "Host prepares, guest computes, host reports." },
  { id: "approval-demo", label: "approval-demo", note: "Parks at a human gate, then writes a file in the guest." },
];

const TERMINAL = new Set(["finished", "failed", "cancelled", "canceled", "error"]);

export function App() {
  const [run, setRun] = useState(null);
  const [token, setToken] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [health, setHealth] = useState(null);
  const pollRef = useRef(null);

  const post = useCallback((message) => {
    try {
      window.parent?.postMessage(message, "*");
    } catch {
      // Not embedded, or a parent that refuses messages. The app still works.
    }
  }, []);

  // Report every state change to the hosting page so its buttons and status
  // line reflect the same engine state this app is showing.
  useEffect(() => {
    post({
      type: "stereos-state",
      status: run?.status ?? "idle",
      workflow: run?.workflow ?? null,
      runId: run?.runId ?? null,
      elapsedMs: run?.elapsedMs ?? null,
      guest: run?.result?.guest ?? null,
      error,
    });
  }, [run, error, post]);

  useEffect(() => {
    let live = true;
    const read = () =>
      fetch("/api/health")
        .then((r) => r.json())
        .then((h) => live && setHealth(h))
        .catch(() => {});
    read();
    const timer = setInterval(read, 5_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  const poll = useCallback((runId) => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const next = await (await fetch(`/api/runs/${runId}`)).json();
        if (next.error) return;
        setRun(next);
        if (TERMINAL.has(next.status)) clearInterval(pollRef.current);
      } catch {
        // Transient; the next tick retries.
      }
    }, 1_000);
  }, []);

  const start = useCallback(
    async (workflow) => {
      setBusy(true);
      setError(null);
      setRun(null);
      setToken(null);
      try {
        const response = await fetch("/api/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workflow }),
        });
        const body = await response.json();
        if (!response.ok || body.error) throw new Error(body.error ?? `start failed (${response.status})`);
        setToken(body.token);
        setRun({ runId: body.runId, workflow, status: "running", nodes: [], result: null });
        poll(body.runId);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(false);
      }
    },
    [poll],
  );

  const decide = useCallback(
    async (approved) => {
      if (!run || !token) return;
      setBusy(true);
      try {
        const response = await fetch(`/api/runs/${run.runId}/approval`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, approved }),
        });
        const body = await response.json();
        if (!response.ok || body.error) throw new Error(body.error ?? "decision failed");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(false);
      }
    },
    [run, token],
  );

  // The hosting page drives the same actions its own buttons expose.
  useEffect(() => {
    const onMessage = (event) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "stereos-start" && typeof data.workflow === "string") {
        if (WORKFLOWS.some((w) => w.id === data.workflow)) start(data.workflow);
      }
      // The page started the run itself and is handing over its token, so the
      // Approve button in here can resolve that run.
      if (data.type === "stereos-adopt" && typeof data.runId === "string" && typeof data.token === "string") {
        setError(null);
        setToken(data.token);
        setRun({ runId: data.runId, workflow: data.workflow, status: "running", nodes: [], result: null });
        poll(data.runId);
      }
      if (data.type === "stereos-approve") decide(data.approved !== false);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [start, decide, poll]);

  useEffect(() => () => clearInterval(pollRef.current), []);

  const waiting = run?.status === "waiting-approval";
  const guest = run?.result?.guest ?? null;
  const stages = (run?.nodes ?? []).map((node) => ({ label: node.label, status: node.status }));

  return (
    <WorkflowUiShell
      title="stereOS demo runs"
      meta={
        health ? (
          <span data-testid="capacity" style={{ fontSize: 12, opacity: 0.7 }}>
            {health.active}/{health.capacity} running{health.queued > 0 ? `, ${health.queued} queued` : ""}
          </span>
        ) : null
      }
      testId="stereos-demo-app"
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        {WORKFLOWS.map((workflow) => (
          <Button
            key={workflow.id}
            type="button"
            size="sm"
            variant={run?.workflow === workflow.id ? "default" : "outline"}
            disabled={busy}
            title={workflow.note}
            data-testid={`start-${workflow.id}`}
            onClick={() => start(workflow.id)}
          >
            {workflow.label}
          </Button>
        ))}
      </div>

      {error ? (
        <p data-testid="demo-error" style={{ color: "#c0392b", fontSize: 13 }}>
          {error}
        </p>
      ) : null}

      {run ? (
        <Card data-testid="run-card" data-run-status={run.status} data-workflow={run.workflow}>
          <CardHeader>
            <CardTitle style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <code style={{ fontSize: 13 }}>{run.workflow}</code>
              <StatusPill status={run.status} />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <StageStrip stages={stages} style={{ marginBottom: 12 }} />

            {waiting ? (
              <div
                data-testid="approval-panel"
                style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 0" }}
              >
                <span style={{ fontSize: 13 }}>Apply the change inside the VM?</span>
                <Button type="button" size="sm" disabled={busy} data-testid="approve" onClick={() => decide(true)}>
                  Approve
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-testid="deny"
                  onClick={() => decide(false)}
                >
                  Deny
                </Button>
              </div>
            ) : null}

            {guest ? (
              <div
                data-testid="guest-evidence"
                style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8 }}
              >
                <KpiStat label="Guest host" value={guest.hostname} />
                <KpiStat label="Guest kernel" value={guest.kernel} />
                <KpiStat label="Guest OS" value={guest.os} />
                <KpiStat label="Guest Bun" value={`${guest.bun} ${guest.arch}`} />
                <KpiStat label="Sandbox" value={`${run.elapsedMs} ms`} />
                <KpiStat label="Write outside workspace" value={guest.writeOutsideWorkspace} />
              </div>
            ) : null}

            {run.result ? (
              <pre
                data-testid="run-result"
                style={{
                  marginTop: 12,
                  maxHeight: 180,
                  overflow: "auto",
                  fontSize: 11,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {JSON.stringify(run.result, null, 2)}
              </pre>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          data-testid="demo-empty"
          title="No run yet"
          description="Pick a workflow. Each one boots its body inside a real stereOS VM on the demo host."
        />
      )}
    </WorkflowUiShell>
  );
}

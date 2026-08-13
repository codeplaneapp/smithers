// Live demo tab: start real runs on the demo host and show what the guest reported.
//
// The page never talks to a Smithers gateway. It talks to the guard, whose
// public surface is four routes. The guard is published through a cloudflared
// tunnel, so the host has no inbound port.
//
// Backend discovery, in order:
//   1. https://stereos-api.smithers.sh - the stable named-tunnel hostname.
//   2. The TXT record _stereos-api.smithers.sh, resolved over DNS-over-HTTPS.
//      The tunnel unit writes its current hostname there on every start, so a
//      restarted quick tunnel is found without redeploying this page.
//
// If neither answers, the tab says so and points at the recorded runs. It never
// shows a fabricated run.

const STABLE = "https://stereos-api.smithers.sh";
const DISCOVERY = "_stereos-api.smithers.sh";
const TERMINAL = new Set(["finished", "failed", "cancelled", "canceled", "error"]);

const banner = document.getElementById("offline-banner");
const statusLine = document.getElementById("live-status");
const frameNote = document.getElementById("frame-note");
const frame = document.getElementById("demo-frame");
const buttons = [...document.querySelectorAll("[data-workflow]")];

const kpi = {
  host: document.getElementById("kpi-host"),
  kernel: document.getElementById("kpi-kernel"),
  os: document.getElementById("kpi-os"),
  bun: document.getElementById("kpi-bun"),
  elapsed: document.getElementById("kpi-elapsed"),
  restrict: document.getElementById("kpi-restrict"),
};

let base = null;
let token = null;
let pollTimer = null;

const setStatus = (text) => {
  statusLine.textContent = text;
};

/** Ask a candidate origin whether it is a healthy guard. */
async function probe(origin) {
  try {
    const response = await fetch(`${origin}/api/health`, {
      signal: AbortSignal.timeout(6000),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const health = await response.json();
    return health?.ok === true ? origin : null;
  } catch {
    return null;
  }
}

/** Read the current backend hostname the tunnel unit published to DNS. */
async function discover() {
  try {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${DISCOVERY}&type=TXT`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(6000),
    });
    const body = await response.json();
    const answer = body?.Answer?.find((entry) => typeof entry.data === "string");
    if (!answer) return null;
    const host = answer.data.replace(/^"|"$/g, "").trim();
    return /^[a-z0-9.-]+$/i.test(host) ? `https://${host}` : null;
  } catch {
    return null;
  }
}

async function connect() {
  base = await probe(STABLE);
  if (!base) {
    const discovered = await discover();
    if (discovered) base = await probe(discovered);
  }
  if (!base) {
    banner.hidden = false;
    frameNote.textContent = "host unreachable";
    setStatus("demo host unreachable");
    for (const button of buttons) button.disabled = true;
    return false;
  }
  banner.hidden = true;
  frame.src = base;
  frameNote.textContent = "connected";
  setStatus("ready");
  return true;
}

function showGuest(run) {
  const guest = run?.result?.guest;
  if (!guest) return;
  kpi.host.textContent = guest.hostname ?? "—";
  kpi.kernel.textContent = guest.kernel ?? "—";
  kpi.os.textContent = guest.os ?? "—";
  kpi.bun.textContent = guest.bun ? `Bun ${guest.bun} ${guest.arch ?? ""}`.trim() : "—";
  kpi.elapsed.textContent = typeof run.elapsedMs === "number" ? `${run.elapsedMs} ms` : "—";
  kpi.restrict.textContent = guest.writeOutsideWorkspace ?? "—";
}

function poll(runId) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const run = await (await fetch(`${base}/api/runs/${runId}`, { cache: "no-store" })).json();
      if (run.error) return;
      setStatus(run.status === "waiting-approval" ? "waiting for your approval, click Approve below" : run.status);
      if (TERMINAL.has(run.status)) {
        clearInterval(pollTimer);
        showGuest(run);
        for (const button of buttons) button.disabled = false;
      }
    } catch {
      // Transient; the next tick retries.
    }
  }, 1000);
}

async function start(workflow) {
  if (!base && !(await connect())) return;
  for (const button of buttons) button.disabled = true;
  setStatus(`starting ${workflow}`);
  for (const value of Object.values(kpi)) value.textContent = "—";
  try {
    const response = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow }),
    });
    const body = await response.json();
    if (!response.ok || body.error) throw new Error(body.error ?? `start failed (${response.status})`);
    token = body.token;
    // Keep the embedded UI on the same run, so its Approve button resolves it.
    frame.contentWindow?.postMessage({ type: "stereos-adopt", runId: body.runId, token, workflow }, "*");
    setStatus(body.queuePosition > 0 ? `queued at position ${body.queuePosition}` : "running");
    poll(body.runId);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
    for (const button of buttons) button.disabled = false;
  }
}

for (const button of buttons) {
  button.addEventListener("click", () => start(button.dataset.workflow));
}

// The embedded UI reports every state change, so a run started inside the frame
// updates this tab's status line and evidence tiles too.
window.addEventListener("message", (event) => {
  if (base && event.origin !== new URL(base).origin) return;
  const data = event.data;
  if (!data || data.type !== "stereos-state") return;
  if (data.status && data.status !== "idle") setStatus(data.status);
  if (data.guest) {
    showGuest({ result: { guest: data.guest }, elapsedMs: data.elapsedMs });
  }
});

connect();

/**
 * The Live demo tab.
 *
 * Everything here drives real runs on the demo host: this file starts a run
 * through the guard, hands the run and its approval token to the embedded run
 * UI, and renders the guest-produced evidence the engine recorded. There is no
 * offline path and no simulation. If the host does not answer, the tab says so
 * and points at the recorded runs.
 */

/** Preferred backend, then the discovery record the tunnel keeps current. */
const NAMED_HOST = "https://stereos-api.smithers.sh";
const DISCOVERY_RECORD = "_stereos-api.smithers.sh";
const TERMINAL = new Set(["finished", "failed", "cancelled", "canceled", "error"]);

const el = (id) => document.getElementById(id);
const startButtons = [...document.querySelectorAll("[data-start]")];
const statusPill = el("live-status");
const capacity = el("live-capacity");
const frame = el("live-frame");
const offline = el("live-offline");
const evidence = el("live-evidence");
const tiles = el("live-tiles");
const runIdOut = el("live-runid");
const originOut = el("live-origin");

let base = null;
let poll = null;
let token = null;

function setStatus(text, tone = "") {
  statusPill.textContent = text;
  statusPill.className = `pill${tone ? ` ${tone}` : ""}`;
}

const toneOf = (status) =>
  status === "finished" ? "ok" : status === "waiting-approval" ? "wait" : TERMINAL.has(status) ? "bad" : "run";

/** Ask a candidate backend whether it is the demo guard. */
async function probe(origin) {
  const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(6_000) });
  const body = await response.json();
  if (!body?.ok || !Array.isArray(body.workflows)) throw new Error("not the demo guard");
  return body;
}

/**
 * Resolve the backend. The tunnel publishes its current hostname to a TXT
 * record; the record holds a hostname only and grants nothing on its own,
 * because the guard is the entire public surface.
 */
async function discover() {
  try {
    return { origin: NAMED_HOST, health: await probe(NAMED_HOST) };
  } catch {
    // The stable hostname is not published yet; fall through to the record.
  }
  const dns = await fetch(`https://cloudflare-dns.com/dns-query?name=${DISCOVERY_RECORD}&type=TXT`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(6_000),
  });
  const answers = (await dns.json())?.Answer ?? [];
  for (const answer of answers) {
    const host = String(answer.data ?? "").replace(/^"|"$/g, "");
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) continue;
    const origin = `https://${host}`;
    try {
      return { origin, health: await probe(origin) };
    } catch {
      // Stale record; try the next answer.
    }
  }
  throw new Error("no demo backend answered");
}

function showEvidence(run) {
  const guest = run?.result?.guest;
  if (!guest) {
    evidence.hidden = true;
    return;
  }
  const rows = [
    ["Guest host", guest.hostname],
    ["Guest OS", guest.os],
    ["Guest kernel", guest.kernel],
    ["Guest runtime", `Bun ${guest.bun} ${guest.arch}`],
    ["Guest memory", `${Math.round(guest.memTotalKb / 1024)} MiB`],
    ["Write outside workspace", guest.writeOutsideWorkspace],
    ["Wall clock", `${run.elapsedMs} ms`],
  ];
  tiles.replaceChildren(
    ...rows.map(([term, value]) => {
      const wrap = document.createElement("div");
      wrap.className = "tile";
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = String(value);
      wrap.append(dt, dd);
      return wrap;
    }),
  );
  runIdOut.textContent = run.runId;
  evidence.hidden = false;
}

function watch(runId) {
  clearInterval(poll);
  poll = setInterval(async () => {
    try {
      const run = await (await fetch(`${base}/api/runs/${runId}`)).json();
      if (run.error) return;
      setStatus(run.status, toneOf(run.status));
      showEvidence(run);
      if (TERMINAL.has(run.status)) clearInterval(poll);
    } catch {
      // Transient; the next tick retries.
    }
  }, 1_000);
}

async function start(workflow) {
  if (!base) return;
  for (const button of startButtons) button.disabled = true;
  evidence.hidden = true;
  setStatus("starting", "run");
  try {
    const response = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow }),
    });
    const body = await response.json();
    if (!response.ok || body.error) throw new Error(body.error ?? `start failed (${response.status})`);
    token = body.token;
    // Hand the run to the embedded UI so its Approve button can resolve it.
    frame.contentWindow?.postMessage(
      { type: "stereos-adopt", runId: body.runId, token, workflow },
      new URL(base).origin,
    );
    setStatus("running", "run");
    watch(body.runId);
  } catch (error) {
    setStatus(error.message, "bad");
  } finally {
    for (const button of startButtons) button.disabled = false;
  }
}

// The embedded UI reports every state change it sees, so a run started from
// inside the iframe updates this tab's status and evidence too.
window.addEventListener("message", (event) => {
  if (!base || event.origin !== new URL(base).origin) return;
  const data = event.data;
  if (data?.type !== "stereos-state" || typeof data.status !== "string") return;
  if (data.status === "idle") return;
  setStatus(data.status, toneOf(data.status));
  if (data.runId) runIdOut.textContent = data.runId;
  // The embedded UI polls too, and either side can see the terminal state
  // first. Render its guest facts as soon as they arrive so the status and the
  // evidence below it never disagree.
  if (data.guest) showEvidence({ runId: data.runId, elapsedMs: data.elapsedMs, result: { guest: data.guest } });
});

async function connect() {
  try {
    const { origin, health } = await discover();
    base = origin;
    originOut.textContent = new URL(origin).host;
    frame.src = `${origin}/`;
    capacity.textContent = `${health.active}/${health.capacity} slots in use`;
    setStatus("ready", "ok");
    for (const button of startButtons) button.disabled = false;
    setInterval(async () => {
      try {
        const health = await probe(base);
        capacity.textContent = `${health.active}/${health.capacity} slots in use`;
      } catch {
        // A missed health tick is not worth surfacing; runs report themselves.
      }
    }, 10_000);
  } catch {
    offline.hidden = false;
    setStatus("host offline", "bad");
    originOut.textContent = "unreachable";
  }
}

for (const button of startButtons) {
  button.addEventListener("click", () => start(button.dataset.start));
}
connect();

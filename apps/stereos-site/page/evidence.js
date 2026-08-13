// How it works tab: the recorded runs, rendered from the committed captures.
//
// Every excerpt below is sliced out of real/transcript-linux.txt at render
// time by matching on text that is present in the committed file. Nothing here
// is retyped, so an edited capture changes the page and a missing marker shows
// as a visible gap rather than stale prose.
import { realRun } from "./real-run.js";

const linux = realRun.hosts.find((host) => host.key === "linux");

/**
 * Take `lines` lines of the capture starting at the first line containing
 * `marker`. Returns a short notice rather than throwing if the marker moved.
 */
function excerpt(transcript, marker, lines) {
  const all = transcript.split("\n");
  const start = all.findIndex((line) => line.includes(marker));
  if (start === -1) return `(marker not present in the capture: ${marker})`;
  return all
    .slice(start, start + lines)
    .join("\n")
    .trimEnd();
}

// One sentence per step, each tied to a stage of the flow diagram above.
const STEPS = [
  ["The host boots the mixtape under QEMU/KVM and waits for the guest's sshd.", "== install official Bun", 2],
  ["The guest has no JavaScript runtime, so the host copies the pinned Bun musl build in.", "1.2.21", 1],
  ["The guest identifies itself: a different kernel, hostname, and distribution from the host.", "== guest ==", 5],
  ["Smithers starts the run on the host and schedules the one Sandbox node.", "[00:00:00] → stereos-vm", 1],
  ["The provider opens the sandbox, uploads the runner and the bundled child workflow, and Bun executes it in the guest.", "SandboxCreated", 1],
  ["The engine records the sandbox lifecycle and its duration.", "SandboxCompleted", 1],
  ["The guest's own result comes back as JSON, reporting facts only the guest can know.", '"summary"', 6],
];

const walkthrough = document.getElementById("walkthrough");
if (walkthrough && linux) {
  walkthrough.innerHTML = "";
  for (const [sentence, marker, lines] of STEPS) {
    const item = document.createElement("li");
    const body = document.createElement("div");
    const heading = document.createElement("h3");
    heading.textContent = sentence;
    const pre = document.createElement("pre");
    pre.textContent = excerpt(linux.transcript, marker, lines);
    body.append(heading, pre);
    item.append(body);
    walkthrough.append(item);
  }
}

// Result cards: one per host, values from the build-time manifest.
const hostCards = document.getElementById("host-cards");
if (hostCards) {
  hostCards.innerHTML = "";
  for (const host of realRun.hosts) {
    const card = document.createElement("div");
    card.className = "card";
    const body = document.createElement("div");
    body.className = "card-body";
    const kind = document.createElement("span");
    kind.className = `kind ${host.key === "linux" ? "guest" : "host"}`;
    kind.textContent = host.key === "linux" ? "x86_64 · KVM" : "aarch64 · Apple";
    const title = document.createElement("h3");
    title.textContent = host.label;
    const list = document.createElement("dl");
    list.className = "kpis";
    list.style.marginTop = "10px";
    for (const [label, value] of Object.entries(host.kpis)) {
      const tile = document.createElement("div");
      tile.className = "kpi";
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      tile.append(dt, dd);
      list.append(tile);
    }
    body.append(kind, title, list);
    card.append(body);
    hostCards.append(card);
  }
}

// Full captures, collapsed. The e2e reads these, so they stay in the DOM.
const raw = document.getElementById("raw-captures");
if (raw) {
  raw.innerHTML = "";
  for (const host of realRun.hosts) {
    const details = document.createElement("details");
    details.className = "raw";
    const summary = document.createElement("summary");
    summary.textContent = `Full capture (unedited) · ${host.label}`;
    const pre = document.createElement("pre");
    pre.id = `capture-${host.key}`;
    pre.tabIndex = 0;
    pre.textContent = host.transcript;
    details.append(summary, pre);
    raw.append(details);
  }
}

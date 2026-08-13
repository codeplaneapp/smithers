// Tab 3: replay recorded transcripts of Smithers runs whose work happened
// inside real stereOS mixtape VMs, and show the sources that produced them.
//
// The transcripts are captured output, not simulations: apps/stereos-site/real/
// holds both the recordings and the code, and build.mjs serializes them here.
import { realRun } from "./real-run.js";

const term = document.getElementById("real-terminal");
const playBtn = document.getElementById("real-play");
const note = document.getElementById("real-note");
const runSelect = document.getElementById("real-run-select");
const sourceSelect = document.getElementById("real-source-select");
const sourceView = document.getElementById("real-source");

const LINE_MS = 28;
const COMMAND_PAUSE_MS = 380;

let lines = [];
let cursor = 0;
let playing = false;
let handle = null;

function stop() {
  playing = false;
  clearTimeout(handle);
}

function showAll() {
  stop();
  term.textContent = lines.join("\n");
  cursor = lines.length;
  term.scrollTop = term.scrollHeight;
  note.textContent = "recorded run";
  playBtn.textContent = "Replay";
}

function tick() {
  if (!playing) return;
  if (cursor >= lines.length) {
    showAll();
    return;
  }
  const line = lines[cursor];
  term.textContent += `${line}\n`;
  cursor += 1;
  term.scrollTop = term.scrollHeight;
  // Hold a beat after each command line so the sequence stays readable.
  handle = setTimeout(tick, line.startsWith("$ ") ? COMMAND_PAUSE_MS : LINE_MS);
}

function loadRun(name) {
  stop();
  lines = realRun.transcripts[name].replace(/\s+$/, "").split("\n");
  showAll();
}

playBtn.addEventListener("click", () => {
  if (playing) {
    showAll();
    return;
  }
  playing = true;
  cursor = 0;
  term.textContent = "";
  note.textContent = "replaying";
  playBtn.textContent = "Skip to end";
  tick();
});

/** Fill a <select> with keys and return the first one. */
function fill(select, keys) {
  for (const key of keys) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = key;
    select.append(option);
  }
  return keys[0];
}

fill(runSelect, Object.keys(realRun.transcripts));
runSelect.addEventListener("change", () => loadRun(runSelect.value));
loadRun(runSelect.value);

fill(sourceSelect, Object.keys(realRun.sources));
sourceSelect.addEventListener("change", () => {
  sourceView.textContent = realRun.sources[sourceSelect.value];
});
sourceView.textContent = realRun.sources[sourceSelect.value];

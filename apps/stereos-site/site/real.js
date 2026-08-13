// Tab 3: replay the recorded transcript of a Smithers run whose work happened
// inside a real stereOS mixtape VM, and show the sources that produced it.
//
// The transcript is captured output, not a simulation: apps/stereos-site/real/
// holds both the recording and the code, and build.mjs serializes them here.
import { realRun } from "./real-run.js";

const term = document.getElementById("real-terminal");
const playBtn = document.getElementById("real-play");
const note = document.getElementById("real-note");
const sourceSelect = document.getElementById("real-source-select");
const sourceView = document.getElementById("real-source");

const lines = realRun.transcript.replace(/\s+$/, "").split("\n");
const LINE_MS = 28;
const COMMAND_PAUSE_MS = 380;

let cursor = 0;
let playing = false;
let handle = null;

function append(count) {
  term.textContent += `${lines.slice(cursor, cursor + count).join("\n")}\n`;
  cursor += count;
  term.scrollTop = term.scrollHeight;
}

function finish() {
  playing = false;
  clearTimeout(handle);
  term.textContent = lines.join("\n");
  cursor = lines.length;
  term.scrollTop = term.scrollHeight;
  note.textContent = "recorded run, complete";
  playBtn.textContent = "Replay";
}

function tick() {
  if (!playing) return;
  if (cursor >= lines.length) {
    finish();
    return;
  }
  const line = lines[cursor];
  append(1);
  // Hold a beat after each command line so the sequence stays readable.
  handle = setTimeout(tick, line.startsWith("$ ") ? COMMAND_PAUSE_MS : LINE_MS);
}

playBtn.addEventListener("click", () => {
  if (playing) {
    finish();
    return;
  }
  playing = true;
  cursor = 0;
  term.textContent = "";
  note.textContent = "replaying";
  playBtn.textContent = "Skip to end";
  tick();
});

for (const name of Object.keys(realRun.sources)) {
  const option = document.createElement("option");
  option.value = name;
  option.textContent = name;
  sourceSelect.append(option);
}
sourceSelect.addEventListener("change", () => {
  sourceView.textContent = realRun.sources[sourceSelect.value];
});
sourceView.textContent = realRun.sources[sourceSelect.value];

// Static by default, so the evidence reads without pressing anything.
term.textContent = lines.join("\n");
note.textContent = "recorded run";

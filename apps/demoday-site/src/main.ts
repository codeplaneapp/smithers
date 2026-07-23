import "./style.css";
import { sections } from "./slides";

interface Step {
  section: number;
  beat: number;
}

const steps: Step[] = [];
sections.forEach((s, si) => {
  for (let b = 0; b < s.steps; b++) steps.push({ section: si, beat: b });
});

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <main class="stage">
    ${sections.map((s, i) => `<section class="slide" data-section="${i}" data-id="${s.id}">${s.render()}</section>`).join("")}
  </main>
  <div class="hud">
    <div class="hud-timer" id="timer" hidden>3:00</div>
    <div class="hud-counter" id="counter"></div>
    <div class="hud-progress"><div class="hud-progress-fill" id="progress"></div></div>
  </div>
  <aside class="notes" id="notes" hidden>
    <div class="notes-label">speaker notes · <kbd>N</kbd> to hide</div>
    <p class="notes-text" id="notes-text"></p>
  </aside>
  <div class="help" id="help">
    <kbd>←</kbd><kbd>→</kbd> navigate · <kbd>N</kbd> notes · <kbd>P</kbd> rehearse · <kbd>T</kbd> 3:00 timer · <kbd>F</kbd> fullscreen
  </div>
`;

const slideEls = Array.from(app.querySelectorAll<HTMLElement>(".slide"));
const counterEl = document.getElementById("counter")!;
const progressEl = document.getElementById("progress")!;
const notesEl = document.getElementById("notes")!;
const notesTextEl = document.getElementById("notes-text")!;
const timerEl = document.getElementById("timer")!;
const helpEl = document.getElementById("help")!;

let index = 0;

function clamp(i: number): number {
  return Math.max(0, Math.min(steps.length - 1, i));
}

function goto(i: number): void {
  index = clamp(i);
  const { section, beat } = steps[index];

  slideEls.forEach((el, si) => {
    el.classList.toggle("active", si === section);
    if (si === section) el.setAttribute("data-beat", String(beat));
  });

  // beat-scoped elements inside the active section (live super-slide)
  const active = slideEls[section];
  active.querySelectorAll<HTMLElement>("[data-i]").forEach((el) => {
    el.classList.toggle("on", Number(el.dataset.i) === beat);
    el.classList.toggle("done", Number(el.dataset.i) < beat);
  });

  counterEl.textContent = `${index + 1} / ${steps.length}`;
  progressEl.style.width = `${((index + 1) / steps.length) * 100}%`;
  notesTextEl.textContent = sections[section].notes[beat] ?? "";
  location.hash = String(index + 1);
}

// ---- timer (3:00 demo-day clock) ----
const LIMIT = 180;
let remaining = LIMIT;
let ticking: number | undefined;

function paintTimer(): void {
  const m = Math.floor(Math.abs(remaining) / 60);
  const s = Math.abs(remaining) % 60;
  timerEl.textContent = `${remaining < 0 ? "-" : ""}${m}:${String(s).padStart(2, "0")}`;
  timerEl.classList.toggle("warn", remaining <= 60 && remaining > 20);
  timerEl.classList.toggle("danger", remaining <= 20);
}

function toggleTimer(): void {
  timerEl.hidden = false;
  if (ticking !== undefined) {
    clearInterval(ticking);
    ticking = undefined;
    return;
  }
  ticking = window.setInterval(() => {
    remaining -= 1;
    paintTimer();
  }, 1000);
}

function resetTimer(): void {
  if (ticking !== undefined) clearInterval(ticking);
  ticking = undefined;
  remaining = LIMIT;
  paintTimer();
  timerEl.hidden = true;
}

// ---- rehearsal mode (P): TTS narration plays and advances the deck in sync ----
interface NarrationStep {
  file: string;
  durationMs: number;
}
let narration: NarrationStep[] | null = null;
let rehearsalAudio: HTMLAudioElement | null = null;
let rehearsalOn = false;

async function loadNarration(): Promise<NarrationStep[] | null> {
  if (narration) return narration;
  try {
    const res = await fetch("narration/manifest.json");
    if (!res.ok) return null;
    const parsed = (await res.json()) as { steps: NarrationStep[] };
    narration = parsed.steps;
    return narration;
  } catch {
    return null;
  }
}

function stopRehearsal(): void {
  rehearsalOn = false;
  if (rehearsalAudio) {
    rehearsalAudio.pause();
    rehearsalAudio = null;
  }
}

function rehearsalHint(message: string): void {
  helpEl.innerHTML = message;
  helpEl.classList.remove("gone");
  window.setTimeout(() => helpEl.classList.add("gone"), 6000);
}

async function toggleRehearsal(): Promise<void> {
  if (rehearsalOn) {
    stopRehearsal();
    return;
  }
  // The manifest is prefetched at boot so this stays synchronous on the happy
  // path — audio.play() must run inside the key press's user-gesture window or
  // Safari (and strict Chrome profiles) will block it.
  const narrationSteps = narration ?? (await loadNarration());
  if (!narrationSteps) {
    rehearsalHint("Narration failed to load — check the connection and press <kbd>P</kbd> again.");
    return;
  }
  rehearsalOn = true;
  resetTimer();
  toggleTimer();
  const playFrom = (i: number): void => {
    if (!rehearsalOn || i >= narrationSteps.length) {
      stopRehearsal();
      return;
    }
    goto(i);
    const audio = new Audio(`narration/${narrationSteps[i].file}`);
    rehearsalAudio = audio;
    audio.onended = () => playFrom(i + 1);
    audio.onerror = () => playFrom(i + 1);
    audio.play().catch(() => {
      stopRehearsal();
      resetTimer();
      rehearsalHint("Audio blocked by the browser — click the page once, then press <kbd>P</kbd> again.");
    });
  };
  playFrom(0);
}

// Prefetch so pressing P can start audio synchronously within the gesture.
void loadNarration();

// ---- input ----
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key) {
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
    case " ":
      e.preventDefault();
      stopRehearsal();
      goto(index + 1);
      break;
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
      e.preventDefault();
      stopRehearsal();
      goto(index - 1);
      break;
    case "Home":
      stopRehearsal();
      goto(0);
      break;
    case "End":
      stopRehearsal();
      goto(steps.length - 1);
      break;
    case "n":
    case "N":
      notesEl.hidden = !notesEl.hidden;
      break;
    case "t":
    case "T":
      toggleTimer();
      break;
    case "p":
    case "P":
      void toggleRehearsal();
      break;
    case "r":
    case "R":
      resetTimer();
      break;
    case "f":
    case "F":
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen();
      break;
  }
});

document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest(".notes") || t.closest(".hud")) return;
  const x = (e as MouseEvent).clientX;
  stopRehearsal();
  if (x > window.innerWidth * 0.33) goto(index + 1);
  else goto(index - 1);
});

// fade the help hint after a few seconds
window.setTimeout(() => helpEl.classList.add("gone"), 6000);

const fromHash = Number(location.hash.slice(1));
goto(Number.isFinite(fromHash) && fromHash >= 1 ? fromHash - 1 : 0);
paintTimer();

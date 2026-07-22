// OpenAI TTS narration for the demo-day deck, one mp3 per navigation step.
// Source of truth for the lines is src/slides.ts (section notes, one per step).
// Generates public/narration/<nn>-<id>.mp3, probes real durations, and writes
// public/narration/manifest.json used by the deck's rehearsal mode.
// Run: bun scripts/narrate.ts [--force]
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sections } from "../src/slides.ts";

const MODEL = "gpt-4o-mini-tts";
const VOICE = "ash";
const INSTRUCTIONS =
  "Confident, energetic founder giving a demo-day pitch; brisk but clear diction; natural emphasis on numbers.";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(APP_DIR, "public", "narration");
const MANIFEST = join(OUT_DIR, "manifest.json");

interface StepLine {
  i: number;
  id: string;
  beat: number;
  line: string;
}

interface ManifestStep extends StepLine {
  file: string;
  durationMs: number;
  words: number;
  hash: string;
}

const stepLines: StepLine[] = [];
sections.forEach((s) => {
  s.notes.forEach((line, beat) => {
    stepLines.push({ i: stepLines.length, id: s.id, beat, line });
  });
});

type ExecResult = { code: number; stdout: string; stderr: string };
function exec(cmd: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    const cp = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    cp.stdout.on("data", (d) => (stdout += d.toString()));
    cp.stderr.on("data", (d) => (stderr += d.toString()));
    cp.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    cp.on("error", (err) => resolve({ code: 1, stdout, stderr: String(err) }));
  });
}

function wordCount(line: string): number {
  return line.split(/\s+/).filter((t) => /[a-z0-9]/i.test(t)).length;
}

function lineHash(line: string): string {
  return createHash("sha256")
    .update(`${MODEL}|${VOICE}|${INSTRUCTIONS}|${line}`)
    .digest("hex")
    .slice(0, 16);
}

async function synth(line: string, outMp3: string, apiKey: string): Promise<void> {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      voice: VOICE,
      input: line,
      instructions: INSTRUCTIONS,
      response_format: "mp3",
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI TTS ${res.status}: ${detail.slice(0, 300)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0) throw new Error("OpenAI TTS returned an empty body");
  writeFileSync(outMp3, buf);
}

async function probeDurationMs(file: string): Promise<number> {
  const probe = await exec("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
  ]);
  const secs = Number.parseFloat(probe.stdout.trim());
  if (Number.isFinite(secs) && secs > 0) return Math.round(secs * 1000);
  return 0;
}

function loadPreviousManifest(): Map<string, ManifestStep> {
  if (!existsSync(MANIFEST)) return new Map();
  try {
    const parsed = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
      steps?: ManifestStep[];
    };
    return new Map((parsed.steps ?? []).map((s) => [s.file, s]));
  } catch {
    return new Map();
  }
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) throw new Error("OPENAI_API_KEY unset — real TTS required");
  mkdirSync(OUT_DIR, { recursive: true });
  const previous = loadPreviousManifest();

  const steps: ManifestStep[] = [];
  for (const s of stepLines) {
    const name = `${String(s.i + 1).padStart(2, "0")}-${s.id}${s.beat > 0 || s.id === "live" ? `-${s.beat + 1}` : ""}.mp3`;
    const outFile = join(OUT_DIR, name);
    const hash = lineHash(s.line);
    const prev = previous.get(name);
    const cached =
      !force &&
      prev?.hash === hash &&
      existsSync(outFile) &&
      statSync(outFile).size > 0;
    if (cached) {
      console.log(`[${name}] cached`);
    } else {
      await synth(s.line, outFile, apiKey);
      console.log(`[${name}] generated via ${MODEL}/${VOICE}`);
    }
    const durationMs = await probeDurationMs(outFile);
    steps.push({ ...s, file: name, durationMs, words: wordCount(s.line), hash });
  }

  const totalMs = steps.reduce((sum, r) => sum + r.durationMs, 0);
  writeFileSync(
    MANIFEST,
    JSON.stringify({ model: MODEL, voice: VOICE, instructions: INSTRUCTIONS, totalMs, steps }, null, 2) + "\n",
  );

  const fmt = (ms: number) => {
    const secs = ms / 1000;
    const m = Math.floor(secs / 60);
    return `${m}:${(secs - m * 60).toFixed(1).padStart(4, "0")}`;
  };
  console.log("\n" + "step".padEnd(24) + "words".padStart(6) + "dur".padStart(8) + "cume".padStart(8));
  console.log("-".repeat(46));
  let running = 0;
  for (const r of steps) {
    running += r.durationMs;
    console.log(`${r.i + 1}  ${r.id}${r.id === "live" ? `·${r.beat + 1}` : ""}`.padEnd(24) + String(r.words).padStart(6) + fmt(r.durationMs).padStart(8) + fmt(running).padStart(8));
  }
  console.log("-".repeat(46));
  console.log("TOTAL".padEnd(24) + String(steps.reduce((sum, r) => sum + r.words, 0)).padStart(6) + fmt(totalMs).padStart(8) + fmt(totalMs).padStart(8));
}

main().catch((err) => {
  console.error("narrate failed:", err);
  process.exit(1);
});

/**
 * Node tail HUD — fixed header + stream body + bottom control dock.
 * Used by `smithers tail --node <id> --hud` / thin node-detail-entry so s/h/q
 * chrome stays pinned at the bottom (never in the stream body).
 *
 * Stream layout is hybrid:
 *   - live / working  → stick-bottom (follow latest tokens)
 *   - done / linger   → top-down (read from the start; no empty pad above)
 */

import pc from "picocolors";
import { sanitizeTerminalText } from "./sanitizeTerminalText.js";

const ESC = "\x1b";
const ENTER_ALT = `${ESC}[?1049h`;
const EXIT_ALT = `${ESC}[?1049l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_HOME = `${ESC}[H${ESC}[2J`;
const HOME = `${ESC}[H`;
/** Clear from cursor to end of screen — kills leftover cells when a line shortens. */
const CLEAR_DOWN = `${ESC}[J`;
/** Erase from cursor to end of line — used by the per-row diff writer. */
const CLEAR_EOL = `${ESC}[K`;
/** DEC synchronized update: batch a repaint so the terminal never shows a partial frame (ignored where unsupported). */
const SYNC_ON = `${ESC}[?2026h`;
const SYNC_OFF = `${ESC}[?2026l`;
/** Coalesce bursts of updates (stream tokens, steer keystrokes) into one repaint per tick. */
const PAINT_COALESCE_MS = 16;

/**
 * Terminal display columns (treat fullwidth / wide glyphs as 2).
 * @param {string} s
 */
function displayWidth(s) {
  const plain = String(s).replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of plain) {
    const c = ch.codePointAt(0) ?? 0;
    if (/\p{Mark}/u.test(ch) || c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) {
      continue;
    }
    if (
      (c >= 0xff01 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe10 && c <= 0xfe19) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0x20000 && c <= 0x3fffd) ||
      (c >= 0x1f000 && c <= 0x1faff) ||
      c === 0x3000
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/**
 * Fit content to exactly `width` display columns (pad or truncate).
 * @param {string} s
 * @param {number} width
 */
function fit(s, width) {
  const plain = String(s).replace(/\x1b\[[0-9;]*m/g, "");
  const dw = displayWidth(plain);
  if (dw === width) return s;
  if (dw < width) return s + " ".repeat(width - dw);
  // Truncate by display width
  let acc = "";
  let w = 0;
  for (const ch of plain) {
    const cw = displayWidth(ch);
    if (w + cw > width - 1) break;
    acc += ch;
    w += cw;
  }
  return acc + "…" + " ".repeat(Math.max(0, width - displayWidth(acc) - 1));
}

/**
 * Full-width box edge: ┌───┐ / └───┘ / │…│
 * @param {"top" | "bot" | "mid"} kind
 * @param {number} cols
 */
function boxEdge(kind, cols) {
  const inner = Math.max(0, cols - 2);
  const bar = "─".repeat(inner);
  if (kind === "top") return pc.dim(`┌${bar}┐`);
  if (kind === "bot") return pc.dim(`└${bar}┘`);
  return pc.dim(`├${bar}┤`);
}

/**
 * @param {string} content  may include ANSI
 * @param {number} cols
 */
function boxRow(content, cols) {
  const inner = Math.max(0, cols - 2);
  return pc.dim("│") + fit(` ${content}`.replace(/^\s/, " "), inner) + pc.dim("│");
}

/**
 * @param {{
 *   stdout?: NodeJS.WriteStream,
 *   runId: string,
 *   nodeId: string,
 * }} opts
 */
export function createNodeHud(opts) {
  const stdout = opts.stdout ?? process.stdout;
  const runId = sanitizeTerminalText(opts.runId);
  const nodeId = sanitizeTerminalText(opts.nodeId);
  let entered = false;
  /** @type {string[]} */
  const body = [];
  /** Status/error band just above the dock (full width, does not pollute body). */
  /** @type {string[]} */
  const banner = [];
  let status = "starting";
  let attempt = 1;
  /** @type {"idle" | "input" | "linger"} */
  let dockMode = "idle";
  let inputBuf = "";
  let dockNote = "";
  const MAX_BODY = 400;
  const MAX_BANNER = 8;
  /** Index of the body row receiving the current stream chunk. */
  let streamBodyIndex = null;
  // Anti-flicker: diff each frame against the last and rewrite only changed
  // rows, and coalesce bursts of updates into one repaint per tick.
  /** @type {string[] | null} */
  let lastFrame = null;
  let lastCols = 0;
  let paintScheduled = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let paintTimer = null;

  function size() {
    return {
      rows: Math.max(10, stdout.rows || 24),
      cols: Math.max(40, stdout.columns || 80),
    };
  }

  /** Live working → follow tail; finished/linger → top-down inspect. */
  function stickBottom() {
    if (dockMode === "linger") return false;
    const s = String(status);
    return (
      s === "starting" ||
      s === "working" ||
      s === "in-progress" ||
      s === "running" ||
      s === "blocked" ||
      s === "waiting-approval" ||
      s === "waiting-event" ||
      s === "waiting-timer"
    );
  }

  /**
   * @returns {string[]}
   */
  function frame() {
    const { rows, cols } = size();
    /** @type {string[]} */
    const lines = [];

    const stCol =
      status === "working" || status === "in-progress" || status === "running"
        ? pc.cyan(status)
        : status === "failed" || status === "blocked"
          ? pc.red(status)
          : status === "done" || status === "finished"
            ? pc.green(status)
            : pc.dim(String(status));

    // ── Header box (3) ───────────────────────────────────────────────
    lines.push(boxEdge("top", cols));
    lines.push(boxRow(`${pc.bold(nodeId)}  ·  run ${runId}  ·  ${stCol}  ·  attempt ${attempt}`, cols));
    lines.push(boxEdge("bot", cols));

    // ── Body ─────────────────────────────────────────────────────────
    // dock is a closed 4-line box at the bottom; optional banner above it
    const dockH = 4;
    const headerH = 3;
    const available = Math.max(0, rows - headerH - dockH);
    const visibleBanner = banner.slice(-Math.max(0, available - 3));
    const bannerLines = visibleBanner.length > 0 ? visibleBanner.length + 2 : 0; // + edges
    const bodyH = Math.max(0, available - bannerLines);

    const visibleBody = stickBottom() ? body.slice(-bodyH) : body.slice(0, bodyH);
    const slice = visibleBody.map((b) => fit(b, cols));
    const pad = bodyH - slice.length;
    if (stickBottom()) {
      for (let i = 0; i < pad; i++) lines.push(fit("", cols));
      for (const b of slice) lines.push(b);
    } else {
      for (const b of slice) lines.push(b);
      for (let i = 0; i < pad; i++) lines.push(fit("", cols));
    }

    // ── Status / error banner (full width, above dock) ───────────────
    if (visibleBanner.length > 0) {
      lines.push(boxEdge("top", cols));
      for (const b of visibleBanner) {
        const isErr = /error|failed|no conversation/i.test(b);
        lines.push(boxRow(isErr ? pc.red(b) : pc.yellow(b), cols));
      }
      lines.push(boxEdge("bot", cols));
    }

    // ── Dock box (exactly 4 lines, full width, self-contained) ───────
    lines.push(boxEdge("top", cols));
    if (dockMode === "input") {
      lines.push(boxRow(`${pc.cyan("steer:")} ${inputBuf}█`, cols));
      lines.push(boxRow(pc.dim("Enter send · Esc cancel"), cols));
    } else if (dockMode === "linger") {
      lines.push(boxRow(`${pc.bold("[ h hijack ]")}   ${pc.bold("[ q close ]")}`, cols));
      lines.push(boxRow(pc.dim(dockNote || "run finished — steer only while working"), cols));
    } else {
      lines.push(boxRow(`${pc.bold("[ s steer ]")}   ${pc.bold("[ h hijack ]")}   ${pc.bold("[ q close ]")}`, cols));
      lines.push(boxRow(pc.dim(dockNote || "dual-control dock"), cols));
    }
    lines.push(boxEdge("bot", cols));

    // Hard guarantee: exactly `rows` lines, each exactly `cols` display cells.
    while (lines.length < rows) lines.push(fit("", cols));
    return lines.slice(0, rows).map((ln) => fit(ln, cols));
  }

  // Rewrite only the rows that changed, inside a synchronized-update block so
  // the terminal never flashes a partially-cleared frame. Full redraw only on
  // first paint / size change (CLEAR_DOWN kills leftover cells when lines shorten).
  function paintNow() {
    if (!entered) return;
    const { cols } = size();
    const f = frame();
    if (!lastFrame || lastFrame.length !== f.length || lastCols !== cols) {
      stdout.write(SYNC_ON + HOME + CLEAR_DOWN + f.join("\n") + SYNC_OFF);
    } else {
      let out = "";
      for (let i = 0; i < f.length; i++) {
        if (f[i] !== lastFrame[i]) out += `${ESC}[${i + 1};1H${CLEAR_EOL}${f[i]}`;
      }
      if (out) stdout.write(SYNC_ON + out + SYNC_OFF);
    }
    lastFrame = f;
    lastCols = cols;
  }

  // Coalesce bursts (stream tokens, steer keystrokes) into one repaint per tick.
  function paint() {
    if (!entered || paintScheduled) return;
    paintScheduled = true;
    paintTimer = setTimeout(() => {
      paintScheduled = false;
      paintTimer = null;
      paintNow();
    }, PAINT_COALESCE_MS);
    if (paintTimer && typeof paintTimer.unref === "function") paintTimer.unref();
  }

  function enter() {
    if (entered) return;
    entered = true;
    lastFrame = null;
    stdout.write(ENTER_ALT + HIDE_CURSOR + CLEAR_HOME);
    if (typeof stdout.on === "function") stdout.on("resize", paintNow);
    paintNow();
  }

  function exit() {
    if (!entered) return;
    entered = false;
    if (paintTimer) {
      clearTimeout(paintTimer);
      paintTimer = null;
      paintScheduled = false;
    }
    lastFrame = null;
    if (typeof stdout.off === "function") stdout.off("resize", paintNow);
    else stdout.removeListener?.("resize", paintNow);
    stdout.write(SHOW_CURSOR + EXIT_ALT);
  }

  /** @param {string} line */
  function pushBody(line) {
    streamBodyIndex = null;
    const safeLine = sanitizeTerminalText(String(line));
    for (const part of safeLine.split("\n")) {
      if (part === "" && safeLine.endsWith("\n")) continue;
      body.push(part);
    }
    while (body.length > MAX_BODY) body.shift();
    paint();
  }

  /**
   * @param {{ status?: string, attempt?: number, note?: string }} p
   */
  function setMeta(p) {
    if (typeof p.status === "string") status = sanitizeTerminalText(p.status);
    if (typeof p.attempt === "number") attempt = p.attempt;
    if (typeof p.note === "string") dockNote = sanitizeTerminalText(p.note);
    paint();
  }

  /**
   * @param {"idle" | "input" | "linger"} mode
   * @param {string} [buf]
   */
  function setDock(mode, buf) {
    dockMode = mode;
    if (typeof buf === "string") inputBuf = sanitizeTerminalText(buf);
    paint();
  }

  /**
   * Replace the status/error band above the dock (full-width, stable layout).
   * @param {string | string[]} lines
   */
  function setBanner(lines) {
    const arr = Array.isArray(lines) ? lines : [String(lines ?? "")];
    banner.length = 0;
    for (const ln of arr) {
      for (const part of sanitizeTerminalText(String(ln)).split("\n")) {
        const t = part.trimEnd();
        if (t !== "") banner.push(t);
      }
    }
    while (banner.length > MAX_BANNER) banner.shift();
    paint();
  }

  /** @param {string} line */
  function pushBanner(line) {
    for (const part of sanitizeTerminalText(String(line)).split("\n")) {
      const t = part.trimEnd();
      if (t !== "") banner.push(t);
    }
    while (banner.length > MAX_BANNER) banner.shift();
    paint();
  }

  /** Append streaming output chunks without turning every token delta into a new row. */
  function emit(text) {
    const safe = sanitizeTerminalText(String(text ?? ""));
    const parts = safe.split("\n");
    if (streamBodyIndex == null) {
      body.push("");
      streamBodyIndex = body.length - 1;
    }
    body[streamBodyIndex] += parts[0];
    for (let i = 1; i < parts.length; i += 1) {
      if (i === parts.length - 1 && parts[i] === "") {
        streamBodyIndex = null;
      } else {
        body.push(parts[i]);
        streamBodyIndex = body.length - 1;
      }
    }
    while (body.length > MAX_BODY) {
      body.shift();
      if (streamBodyIndex != null) streamBodyIndex -= 1;
    }
    paint();
  }

  return {
    enter,
    exit,
    paint,
    pushBody,
    setMeta,
    setDock,
    setBanner,
    pushBanner,
    /** Route stream text into body */
    emit,
  };
}

// src/virtualClock.ts
function createVirtualClock(options = {}) {
  const mode = options.mode === "real" ? "real" : "virtual";
  let current = typeof options.startMs === "number" && Number.isFinite(options.startMs) ? options.startMs : 0;
  async function advance(ms) {
    const n = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : 0;
    if (mode === "real") {
      if (n > 0) {
        await new Promise((r) => setTimeout(r, n));
      }
      return;
    }
    current += n;
  }
  return {
    mode,
    now() {
      return mode === "real" ? Date.now() : current;
    },
    advance,
    sleep: advance,
    setNow(ms) {
      if (mode === "virtual" && typeof ms === "number" && Number.isFinite(ms)) {
        current = ms;
      }
    }
  };
}
export {
  createVirtualClock
};

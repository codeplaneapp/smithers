import { oneshotCodexPauseDetail } from "./oneshotCodexPauseDetail.js";

/** @param {NodeJS.ProcessEnv} [env] */
export function oneshotCodexPaused(env = process.env) {
  return oneshotCodexPauseDetail(env).paused;
}

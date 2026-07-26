import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { oneshotConfigPath } from "./oneshotConfigPath.js";

/**
 * @param {{ review: "on" | "off" | null; trivial: "direct" | "oneshot" | null; announced: boolean }} value
 * @param {NodeJS.ProcessEnv} [env]
 */
export function saveOneshotConfig(value, env = process.env) {
  const path = oneshotConfigPath(env);
  let existing = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed;
  } catch {}
  const contents = { ...existing, version: 1, oneshot: value };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, `${JSON.stringify(contents, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(tmp, 0o600);
  try {
    renameSync(tmp, path);
  } catch (cause) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    throw cause;
  }
  chmodSync(path, 0o600);
  return path;
}

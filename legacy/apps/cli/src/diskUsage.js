import { spawn } from "node:child_process";
import { statfsSync } from "node:fs";

/** @param {string} path */
export function directorySizeBytes(path) {
  return new Promise((resolve) => {
    const child = spawn("du", ["-sk", path], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.on("error", () => resolve(0));
    child.on("close", () => {
      const kib = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "", 10);
      resolve(Number.isFinite(kib) ? kib * 1024 : 0);
    });
  });
}

/** @param {string} path */
export function filesystemUsage(path) {
  try {
    const stat = statfsSync(path);
    const blockSize = Number(stat.bsize);
    const totalBytes = Number(stat.blocks) * blockSize;
    const freeBytes = Number(stat.bavail) * blockSize;
    return {
      path,
      totalBytes,
      freeBytes,
      usedBytes: Math.max(0, totalBytes - freeBytes),
      usedPercent: totalBytes > 0 ? ((totalBytes - freeBytes) / totalBytes) * 100 : 0,
    };
  } catch {
    return null;
  }
}

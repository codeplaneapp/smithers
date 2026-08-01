import { spawnSync } from "node:child_process";

const runtimeGlibc = process.report?.getReport?.().header?.glibcVersionRuntime;
const [glibcMajor = 0, glibcMinor = 0] = typeof runtimeGlibc === "string" ? runtimeGlibc.split(".").map(Number) : [];

export const nanocodexTestSupported =
  process.platform === "linux" &&
  process.arch === "x64" &&
  (glibcMajor > 2 || (glibcMajor === 2 && glibcMinor >= 35)) &&
  spawnSync(
    "/usr/bin/bwrap",
    [
      "--unshare-pid",
      "--die-with-parent",
      "--new-session",
      "--bind",
      "/",
      "/",
      "--proc",
      "/proc",
      "--dev-bind",
      "/dev",
      "/dev",
      "--",
      "/bin/true",
    ],
    { stdio: "ignore", timeout: 5_000 },
  ).status === 0;

const runtimeGlibc = process.report?.getReport?.().header?.glibcVersionRuntime;
const [glibcMajor = 0, glibcMinor = 0] = typeof runtimeGlibc === "string" ? runtimeGlibc.split(".").map(Number) : [];

export const nanocodexHostTarget =
  process.platform === "darwin" && process.arch === "arm64"
    ? "aarch64-apple-darwin"
    : "x86_64-unknown-linux-gnu";

export const nanocodexTestSupported =
  (process.platform === "darwin" && process.arch === "arm64") ||
  (process.platform === "linux" &&
    process.arch === "x64" &&
    (glibcMajor > 2 || (glibcMajor === 2 && glibcMinor >= 35)));

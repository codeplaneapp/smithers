import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Resolved, env-overridable paths and constants for the SWE-Bench Pro harness.
 *
 * Everything the harness touches on disk is rooted here so a run is fully
 * reproducible from a clean checkout: the vendored canonical harness (run
 * scripts + parsers + dockerfiles from ScaleAI), the dataset JSONL, and the
 * scratch directory used for per-instance checkouts and scoring workspaces.
 */
export const config = {
  /** Package root (benchmarks/swe-bench-pro). */
  root: resolve(here, ".."),
  /** Monorepo root (two levels up from the package). */
  repoRoot: resolve(here, "..", "..", ".."),
  /** Local smithers CLI entry, run via bun (avoids a possibly-stale global install). */
  cliEntry: join(resolve(here, "..", "..", ".."), "apps", "cli", "src", "index.js"),
  /** Workflow used for patch generation. */
  workflowPath: join(resolve(here, ".."), "workflow.tsx"),
  /** Vendored clone of github.com/scaleapi/SWE-bench_Pro-os (run_scripts, dockerfiles, eval). */
  harnessDir: process.env.SWEBP_HARNESS_DIR
    ? resolve(process.env.SWEBP_HARNESS_DIR)
    : join(resolve(here, ".."), "vendor", "SWE-bench_Pro-os"),
  /** Normalized dataset (one JSON object per line; list fields kept as original strings). */
  datasetPath: process.env.SWEBP_DATASET
    ? resolve(process.env.SWEBP_DATASET)
    : join(resolve(here, ".."), "data", "swe-bench-pro-test.jsonl"),
  /** Scratch root for checkouts, scoring workspaces, and reports. */
  workDir: process.env.SWEBP_WORKDIR
    ? resolve(process.env.SWEBP_WORKDIR)
    : join(resolve(here, ".."), ".work"),
  /** Docker Hub account that hosts the prebuilt per-instance images. */
  dockerhubUsername: process.env.SWEBP_DOCKERHUB_USERNAME ?? "jefzda",
  /** Platform for `docker run` — images are amd64; arm64 hosts emulate. */
  dockerPlatform: process.env.SWEBP_DOCKER_PLATFORM ?? "linux/amd64",
  /** Upstream sources, recorded for provenance. */
  upstream: {
    harnessRepo: "https://github.com/scaleapi/SWE-bench_Pro-os.git",
    dataset: "ScaleAI/SWE-bench_Pro",
    datasetSplit: "test",
  },
};

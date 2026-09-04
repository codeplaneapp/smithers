#!/usr/bin/env node
/**
 * The `smithers-review` entry point.
 *
 * The module it loads exports its helpers and starts nothing, so a test can
 * import them without running a review. Starting the CLI is this file's whole
 * job.
 */
import { runReviewCli } from "../src/cli/main.ts";

runReviewCli().catch((error) => {
  console.error(`smithers-review: ${error?.message ?? String(error)}`);
  process.exit(1);
});

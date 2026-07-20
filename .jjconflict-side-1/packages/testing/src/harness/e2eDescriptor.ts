import type { Harness } from "./Harness.ts";
import { makeHarness, type HarnessConfig } from "./Harness.ts";
export const e2eDescriptor = (config: HarnessConfig = {}): Harness => makeHarness("e2e-real-process", config);

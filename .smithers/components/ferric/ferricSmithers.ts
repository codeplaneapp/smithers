import { createSmithers } from "smithers-orchestrator";
import { ferricSchemas } from "./ferricSchemas";

/**
 * The campaign's single Smithers binding.
 *
 * The workflow and every `ferric/` component import `Task` and `outputs` from
 * here rather than each calling `createSmithers` themselves, so every reader and
 * writer resolves to the *same* registered output targets. Two calls would
 * produce two sets of table references for the same names.
 */
export const { Workflow, Task, smithers, outputs } = createSmithers(ferricSchemas);

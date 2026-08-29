import { readFileSync } from "node:fs"

/**
 * The model settlements SWE-bench wave 5 rejected as `imports_forbidden`.
 *
 * Each file is the verbatim final `cell` block of one recorded settlement,
 * lifted from that instance's journal at
 * `evals/swebench/work/<instance>/.flows/engine.db`, and named for the journal
 * sequence of the `control.agent.cell-settled` event that rejected it. All five
 * are legitimate cells: the only imports in them are inside a `bash` command's
 * Python heredoc or a `grep` pattern.
 */
export const rejectedCellNames = [
  "astropy-8707-seq82",
  "django-16612-seq218",
  "django-16612-seq299",
  "django-16612-seq493",
  "sphinx-11445-seq12"
] as const

/**
 * One recorded settlement, as the model wrote it.
 */
export const rejectedCell = (name: typeof rejectedCellNames[number]): string =>
  readFileSync(new URL(`./rejected-cells/${name}.md`, import.meta.url), "utf8")

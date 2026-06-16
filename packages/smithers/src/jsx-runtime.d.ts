import type { ReactElement } from "react";

/** Element key accepted by the JSX runtime factories. */
export type JsxRuntimeKey = string | number | undefined;

/**
 * Smithers JSX runtime factories — the target of
 * `jsxImportSource: "smithers-orchestrator"` and what `<Workflow/>`, `<Task/>`,
 * etc. compile to. They are deliberately typed wide (`type`/`props` as
 * `unknown`): components validate their own props, and keeping these signatures
 * loose avoids expanding Smithers' deep workflow types during type-checking,
 * which is otherwise expensive. Callers that build trees programmatically can
 * use these directly, e.g. `jsx(Task, { id, output, agent, children }, key)`.
 */
export function jsx(type: unknown, props: unknown, key?: JsxRuntimeKey): ReactElement;
export function jsxs(type: unknown, props: unknown, key?: JsxRuntimeKey): ReactElement;
export function jsxDEV(
  type: unknown,
  props: unknown,
  key?: JsxRuntimeKey,
  isStaticChildren?: boolean,
  source?: unknown,
  self?: unknown,
): ReactElement;
export const Fragment: unknown;

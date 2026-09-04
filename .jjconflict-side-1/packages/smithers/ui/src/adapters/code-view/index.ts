/**
 * `@smthrs/ui/adapters/code-view`
 *
 * One repository file, syntax highlighted by `@pierre/diffs` `File` (Shiki
 * underneath), on the same engine and theme mapping as the diff view. It
 * ships behind this explicit subpath (never the base `ui` barrel) so
 * importing the base component library never pulls pierre or Shiki.
 */
export {
  CODE_VIEW_REST_MS,
  CodeFileView,
  languageForFile,
  type CodeFileViewProps,
  type CodeLineAnnotation,
  type CodeTokenPosition,
  type CodeViewMode,
} from "./CodeFileView";
export {
  CODE_VIEW_POOL_DEADLINE_MS,
  currentCodeViewPool,
  subscribeCodeViewPool,
  type CodeViewPool,
  type CodeViewPoolState,
} from "./workerPool";

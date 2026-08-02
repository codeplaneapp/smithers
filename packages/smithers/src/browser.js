// Public browser facade. Deliberately does NOT re-export from `./index.js` —
// that barrel pulls in the Node engine, database factories, CLI agents, tools,
// and server code. This module only re-exports the browser-safe surface from
// `@smthrs/engine/browser`.
export {
  createBrowserSmithers,
  runBrowserWorkflow,
  createBrowserRuntime,
  defineBrowserWorkflow,
  Task,
  Workflow,
  Sequence,
  Worktree,
  RuntimeCapabilityError,
  RUNTIME_CAPABILITY_UNAVAILABLE,
} from "@smthrs/engine/browser";

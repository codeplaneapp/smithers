// Helpers for the interactive "update changed pack files" flow in `smithers
// init`. Pure functions over the in-memory template file list — no fs — so they
// are cheap to call and easy to unit-test.

const COMPONENT_RE = /^\.smithers\/components\/(.+?)(?:\.[^./]+)?$/;
const WORKFLOW_RE = /^\.smithers\/workflows\/(.+?)\.tsx?$/;

/**
 * Component base name (".smithers/components/Review.tsx" -> "Review"), or null
 * when the path is not a `.smithers/components/*` file.
 * @param {string} path
 * @returns {string | null}
 */
export function componentBaseName(path) {
  const m = COMPONENT_RE.exec(path);
  return m ? m[1] : null;
}

/**
 * Workflow id (".smithers/workflows/implement.tsx" -> "implement"), or null.
 * @param {string} path
 * @returns {string | null}
 */
export function workflowId(path) {
  const m = WORKFLOW_RE.exec(path);
  return m ? m[1] : null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a workflow source imports the named component via a `../components/`
 * or `~/components/` specifier (with or without a file extension).
 * @param {string} workflowSource
 * @param {string} componentName
 * @returns {boolean}
 */
export function importsComponent(workflowSource, componentName) {
  const re = new RegExp(`from\\s*["'](?:\\.\\.|~)/components/${escapeRegExp(componentName)}(?:\\.[a-z]+)?["']`);
  return re.test(workflowSource);
}

/**
 * Reverse-dependency map: each shared component base name -> the sorted list of
 * workflow ids that import it. Used to warn that updating a shared component may
 * affect every workflow built on it.
 * @param {Array<{ path: string; contents: string }>} templateFiles
 * @returns {Map<string, string[]>}
 */
export function buildComponentImporterMap(templateFiles) {
  const components = [];
  const workflows = [];
  for (const file of templateFiles) {
    const component = componentBaseName(file.path);
    if (component) components.push(component);
    if (workflowId(file.path)) workflows.push(file);
  }
  const map = new Map();
  for (const component of components) {
    const importers = [];
    for (const workflow of workflows) {
      if (importsComponent(workflow.contents, component)) {
        const id = workflowId(workflow.path);
        if (id) importers.push(id);
      }
    }
    map.set(component, importers.sort());
  }
  return map;
}

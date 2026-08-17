/** @param {string} name @param {string} pattern */
function matches(name, pattern) {
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

/**
 * Apply the environment declared by `smithers(build, { environment })` for
 * graph rendering and engine execution. Module evaluation necessarily happens
 * first so the declaration can be read. Returns an idempotent restore function.
 *
 * @param {{ opts?: { environment?: { inherit?: boolean, allow?: string[], deny?: string[], set?: Record<string, string> } } }} workflow
 * @param {NodeJS.ProcessEnv} [target]
 */
export function applyWorkflowEnvironment(workflow, target = process.env) {
  const contract = workflow.opts?.environment;
  if (!contract) return () => {};
  if (contract.inherit !== undefined && typeof contract.inherit !== "boolean") {
    throw new TypeError("workflow environment.inherit must be boolean");
  }
  for (const field of ["allow", "deny"]) {
    if (contract[field] !== undefined && !Array.isArray(contract[field])) {
      throw new TypeError(`workflow environment.${field} must be an array of variable names or prefix* patterns`);
    }
  }
  if (
    contract.set !== undefined &&
    (!contract.set || typeof contract.set !== "object" || Array.isArray(contract.set))
  ) {
    throw new TypeError("workflow environment.set must be a string record");
  }
  const before = { ...target };
  const next = contract.inherit === false ? {} : { ...before };
  for (const pattern of contract.allow ?? []) {
    for (const [key, value] of Object.entries(before)) {
      if (matches(key, pattern)) next[key] = value;
    }
  }
  for (const pattern of contract.deny ?? []) {
    for (const key of Object.keys(next)) {
      if (matches(key, pattern)) delete next[key];
    }
  }
  for (const [key, value] of Object.entries(contract.set ?? {})) {
    if (typeof value !== "string") throw new TypeError(`workflow environment.set.${key} must be a string`);
    next[key] = value;
  }
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, before);
  };
}

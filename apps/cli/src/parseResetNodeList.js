/**
 * Parse a `--reset-node` / `--node` value into the `resetNodes` list a fork
 * takes. Accepts a single node id or a comma-separated list, because a fork
 * resets only the nodes it is given — downstream dependents are never expanded
 * (see `expandResetSet` in `@smthrs/time-travel`), so naming them is the
 * caller's job.
 *
 * Each entry is either a base node id (resets every iteration of that node) or
 * a fully-qualified `nodeId::iteration` key.
 *
 * @param {string | undefined} raw
 * @returns {string[] | undefined} undefined when nothing was requested
 */
export function parseResetNodeList(raw) {
  if (!raw) return undefined;
  const nodes = [
    ...new Set(
      raw
        .split(",")
        .map((nodeId) => nodeId.trim())
        .filter(Boolean),
    ),
  ];
  return nodes.length > 0 ? nodes : undefined;
}

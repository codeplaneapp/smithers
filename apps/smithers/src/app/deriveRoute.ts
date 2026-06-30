import type { RouteState } from "./routeStore";

/**
 * Decode a path segment, falling back to the raw value on a malformed percent
 * sequence. decodeURIComponent throws URIError on inputs like "%"; a malformed
 * deep link must not break the route store's only writer.
 */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Map a resolved location to route state. Pure and decoupled from the route
 * tree: the router owns history and validation, this reads the result. Run
 * surfaces are matched before the bare inspector so the longer paths win.
 */
export function deriveRoute(
  pathname: string,
  search: Record<string, unknown>,
): RouteState {
  const project = typeof search.project === "string" ? search.project : undefined;

  if (pathname === "/") {
    return { view: "home", surface: null, project };
  }

  // Run-surface matchers mirror the TanStack router's PREFIX/param semantics: a
  // deep link with an extra trailing segment (e.g. `/runs/abc/unknown`,
  // `/runs/a/diff/b/extra`) resolves in the router's <Outlet> to the run surface,
  // so deriveRoute (the route store's only writer) must agree — otherwise the
  // shell chrome treats it as the home landing while a run inspector is rendered.
  // Hence the trailing `(?:\/.*)?$` instead of an anchored `\/?$`.
  const diff = pathname.match(/^\/runs\/([^/]+)\/diff\/([^/]+)(?:\/.*)?$/);
  if (diff) {
    return {
      view: "home",
      surface: {
        kind: "diff",
        runId: safeDecode(diff[1]),
        diffId: safeDecode(diff[2]),
      },
      project,
    };
  }
  const logs = pathname.match(/^\/runs\/([^/]+)\/logs(?:\/.*)?$/);
  if (logs) {
    return {
      view: "home",
      surface: { kind: "logs", runId: safeDecode(logs[1]) },
      project,
    };
  }
  const timeline = pathname.match(/^\/runs\/([^/]+)\/timeline(?:\/.*)?$/);
  if (timeline) {
    return {
      view: "home",
      surface: { kind: "timeline", runId: safeDecode(timeline[1]) },
      project,
    };
  }
  const inspector = pathname.match(/^\/runs\/([^/]+)(?:\/.*)?$/);
  if (inspector) {
    return {
      view: "home",
      surface: { kind: "inspector", runId: safeDecode(inspector[1]) },
      project,
    };
  }
  const gatewayRun = pathname.match(/^\/gw\/([^/]+)\/([^/]+)\/?$/);
  if (gatewayRun) {
    return {
      view: "home",
      surface: {
        kind: "gatewayRun",
        workflowKey: safeDecode(gatewayRun[1]),
        runId: safeDecode(gatewayRun[2]),
      },
      project,
    };
  }
  const workflowEditor = pathname.match(/^\/workflow\/([^/]+)\/?$/);
  if (workflowEditor) {
    return {
      view: "home",
      surface: { kind: "workflowEditor", id: safeDecode(workflowEditor[1]) },
      project,
    };
  }
  if (pathname === "/tickets") {
    return { view: "home", surface: { kind: "tickets" }, project };
  }
  if (pathname === "/runs") {
    return { view: "home", surface: { kind: "runs" }, project };
  }
  if (pathname === "/approvals") {
    return { view: "home", surface: { kind: "approvals" }, project };
  }
  if (pathname === "/agents") {
    return { view: "home", surface: { kind: "agents" }, project };
  }
  if (pathname === "/memory") {
    return { view: "home", surface: { kind: "memory" }, project };
  }
  if (pathname === "/prompts") {
    return { view: "home", surface: { kind: "prompts" }, project };
  }
  if (pathname === "/scores") {
    return { view: "home", surface: { kind: "scores" }, project };
  }
  if (pathname === "/crons") {
    return { view: "home", surface: { kind: "crons" }, project };
  }
  if (pathname === "/palette") {
    return { view: "home", surface: { kind: "palette" }, project };
  }
  if (pathname === "/store") {
    return { view: "store", surface: null, project };
  }
  return { view: "notFound", surface: null, project };
}

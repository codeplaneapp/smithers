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
  const project =
    typeof search.project === "string" ? search.project : undefined;
  const workspaceRoot =
    typeof search.workspace === "string" ? search.workspace : undefined;

  if (pathname === "/") {
    return { view: "home", surface: null, project, workspaceRoot };
  }

  const gatewayDiff = pathname.match(/^\/gw\/([^/]+)\/([^/]+)\/diff\/([^/]+)(?:\/.*)?$/);
  if (gatewayDiff) {
    return {
      view: "home",
      surface: {
        kind: "gatewayRun",
        workflowKey: safeDecode(gatewayDiff[1]),
        runId: safeDecode(gatewayDiff[2]),
        view: "diff",
        diffId: safeDecode(gatewayDiff[3]),
      },
      project,
      workspaceRoot,
    };
  }
  const gatewaySubview = pathname.match(/^\/gw\/([^/]+)\/([^/]+)\/(logs|tickets|timeline)(?:\/.*)?$/);
  if (gatewaySubview) {
    return {
      view: "home",
      surface: {
        kind: "gatewayRun",
        workflowKey: safeDecode(gatewaySubview[1]),
        runId: safeDecode(gatewaySubview[2]),
        view: safeDecode(gatewaySubview[3]) as "logs" | "tickets" | "timeline",
      },
      project,
      workspaceRoot,
    };
  }
  const gatewayRun = pathname.match(/^\/gw\/([^/]+)\/([^/]+)(?:\/.*)?$/);
  if (gatewayRun) {
    return {
      view: "home",
      surface: {
        kind: "gatewayRun",
        workflowKey: safeDecode(gatewayRun[1]),
        runId: safeDecode(gatewayRun[2]),
        view: "inspector",
      },
      project,
      workspaceRoot,
    };
  }

  // Legacy `/runs/$id` links are compatibility aliases only. They derive the
  // same gateway-backed route state as `/gw/$id/$id/...`; the router redirects
  // them before any old local-store surface can render.
  const diff = pathname.match(/^\/runs\/([^/]+)\/diff\/([^/]+)(?:\/.*)?$/);
  if (diff) {
    const runId = safeDecode(diff[1]);
    return {
      view: "home",
      surface: {
        kind: "gatewayRun",
        workflowKey: runId,
        runId,
        view: "diff",
        diffId: safeDecode(diff[2]),
      },
      project,
      workspaceRoot,
    };
  }
  const logs = pathname.match(/^\/runs\/([^/]+)\/logs(?:\/.*)?$/);
  if (logs) {
    const runId = safeDecode(logs[1]);
    return {
      view: "home",
      surface: { kind: "gatewayRun", workflowKey: runId, runId, view: "logs" },
      project,
      workspaceRoot,
    };
  }
  const timeline = pathname.match(/^\/runs\/([^/]+)\/timeline(?:\/.*)?$/);
  if (timeline) {
    const runId = safeDecode(timeline[1]);
    return {
      view: "home",
      surface: { kind: "gatewayRun", workflowKey: runId, runId, view: "timeline" },
      project,
      workspaceRoot,
    };
  }
  const tickets = pathname.match(/^\/runs\/([^/]+)\/tickets(?:\/.*)?$/);
  if (tickets) {
    const runId = safeDecode(tickets[1]);
    return {
      view: "home",
      surface: { kind: "gatewayRun", workflowKey: runId, runId, view: "tickets" },
      project,
      workspaceRoot,
    };
  }
  const inspector = pathname.match(/^\/runs\/([^/]+)(?:\/.*)?$/);
  if (inspector) {
    const runId = safeDecode(inspector[1]);
    return {
      view: "home",
      surface: { kind: "gatewayRun", workflowKey: runId, runId, view: "inspector" },
      project,
      workspaceRoot,
    };
  }
  const workflowEditor = pathname.match(/^\/workflow\/([^/]+)\/?$/);
  if (workflowEditor) {
    return {
      view: "home",
      surface: { kind: "workflowEditor", id: safeDecode(workflowEditor[1]) },
      project,
      workspaceRoot,
    };
  }
  if (pathname === "/tickets") {
    return {
      view: "home",
      surface: { kind: "tickets" },
      project,
      workspaceRoot,
    };
  }
  if (pathname === "/vcs") {
    return { view: "home", surface: { kind: "vcs" }, project, workspaceRoot };
  }
  if (pathname === "/runs") {
    return { view: "home", surface: { kind: "runs" }, project, workspaceRoot };
  }
  if (pathname === "/approvals") {
    return {
      view: "home",
      surface: { kind: "approvals" },
      project,
      workspaceRoot,
    };
  }
  if (pathname === "/agents") {
    return {
      view: "home",
      surface: { kind: "agents" },
      project,
      workspaceRoot,
    };
  }
  if (pathname === "/memory") {
    return {
      view: "home",
      surface: { kind: "memory" },
      project,
      workspaceRoot,
    };
  }
  if (pathname === "/files") {
    return { view: "home", surface: { kind: "files" }, project, workspaceRoot };
  }
  if (pathname === "/prompts") {
    return {
      view: "home",
      surface: { kind: "prompts" },
      project,
      workspaceRoot,
    };
  }
  if (pathname === "/scores") {
    return {
      view: "home",
      surface: { kind: "scores" },
      project,
      workspaceRoot,
    };
  }
  if (pathname === "/crons") {
    return { view: "home", surface: { kind: "crons" }, project, workspaceRoot };
  }
  if (pathname === "/gallery") {
    return { view: "home", surface: { kind: "gallery" }, project, workspaceRoot };
  }
  if (pathname === "/palette") {
    return {
      view: "home",
      surface: { kind: "palette" },
      project,
      workspaceRoot,
    };
  }
  if (pathname === "/store") {
    return { view: "store", surface: null, project, workspaceRoot };
  }
  return { view: "notFound", surface: null, project, workspaceRoot };
}

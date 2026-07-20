import { createRoute, redirect } from "@tanstack/react-router";
import { rootRoute } from "../app/rootRoute";

function gatewayParams(runId: string) {
  return { workflowKey: runId, runId };
}

export const legacyRunRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/gw/$workflowKey/$runId",
      params: gatewayParams(params.runId),
      replace: true,
    });
  },
});

export const legacyRunLogsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId/logs",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/gw/$workflowKey/$runId/logs",
      params: gatewayParams(params.runId),
      replace: true,
    });
  },
});

export const legacyRunDiffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId/diff/$diffId",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/gw/$workflowKey/$runId/diff/$diffId",
      params: { ...gatewayParams(params.runId), diffId: params.diffId },
      replace: true,
    });
  },
});

export const legacyRunTimelineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId/timeline",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/gw/$workflowKey/$runId/timeline",
      params: gatewayParams(params.runId),
      replace: true,
    });
  },
});

export const legacyRunTicketsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId/tickets",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/gw/$workflowKey/$runId/tickets",
      params: gatewayParams(params.runId),
      replace: true,
    });
  },
});

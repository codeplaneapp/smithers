/** @jsxImportSource react */
import { createGatewayReactRoot } from "smthrs/gateway-react";
import { SimpleWorkflowDashboard } from "smthrs/gateway-ui";

createGatewayReactRoot(
  <SimpleWorkflowDashboard
    workflow="bug-triage-train"
    title="Bug Triage Train: bug.smithers.sh reports to issues, Luna xhigh investigation lanes, draft PRs"
  />,
);

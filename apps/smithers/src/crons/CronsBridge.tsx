import { useEffect } from "react";
import {
  useGatewayCrons,
  useGatewayMutation,
} from "@smithers-orchestrator/gateway-react";
import {
  gatewayKeys,
  type GatewayCronRow,
} from "@smithers-orchestrator/gateway-client";
import { useLocalModeRefetch } from "../sync/useLocalModeRefetch";
import { describeCron, nameFromWorkflowPath, type Cron } from "./crons";
import { bindCronActions, useCronsStore } from "./cronsStore";

/**
 * Bridge the live `crons` gateway collection into the triggers store
 * (docs/p1b-plan.md §3.1). The Zustand store can't call React hooks, so this
 * component — mounted inside `<SyncProvider>` in `main.tsx` next to
 * `<RunsListBridge/>` / `<ApprovalsBridge/>` — calls `useGatewayCrons()`, maps
 * each `GatewayCronRow` onto a `Cron`, and pushes the result into the store on
 * every change. It also installs the `cronCreate`/`cronDelete` RPC seam
 * (`bindCronActions`) so the store's create/delete/toggle drive the REAL gateway.
 *
 * `cronList` returns ALL crons (enabled + disabled). The gateway keys crons by
 * registered workflow KEY (stored as `gateway:<key>`), so `workflow` IS the key;
 * we surface it as `Cron.workflowPath` and re-feed it to `cronCreate`. `name`
 * and `nextHint` stay CLIENT-derived (`nameFromWorkflowPath`/`describeCron`) —
 * they are NOT on the wire, matching the P1a precedent of keeping presentational
 * metadata client-side.
 */

const CRONS_PARAMS = {} as const;

type CronCreateVars = { workflow: string; pattern: string; enabled: boolean };
type CronDeleteVars = { cronId: string };

/**
 * Map a live `GatewayCronRow` onto the surface's `Cron`. `cronId → id`,
 * `workflow → workflowPath` (the registered key the gateway understands), with
 * `name`/`nextHint` derived client-side. `errorJson` is `string | null` on the
 * wire → coalesce null away so the detail pane only shows a real error block.
 */
export function toCron(row: GatewayCronRow): Cron {
  const workflowRef = typeof row.workflow === "string" && row.workflow.trim() !== ""
    ? row.workflow
    : row.workflowPath;
  return {
    id: row.cronId,
    name: nameFromWorkflowPath(workflowRef),
    pattern: row.pattern,
    workflowPath: workflowRef,
    enabled: row.enabled === true,
    nextHint: describeCron(row.pattern),
    errorJson: typeof row.errorJson === "string" && row.errorJson.trim() !== ""
      ? row.errorJson
      : undefined,
  };
}

export function CronsBridge() {
  const { data, refetch } = useGatewayCrons(CRONS_PARAMS);
  const cronCreate = useGatewayMutation<CronCreateVars, unknown>("cronCreate", {
    invalidate: [gatewayKeys.cronList(CRONS_PARAMS)],
  });
  const cronDelete = useGatewayMutation<CronDeleteVars, unknown>("cronDelete", {
    invalidate: [gatewayKeys.cronList(CRONS_PARAMS)],
  });

  // Install the real RPC seam so the store's create/delete/toggle submit live.
  useEffect(() => {
    bindCronActions({
      create: (vars) => cronCreate.mutate(vars),
      remove: (vars) => cronDelete.mutate(vars),
      refetch,
    });
  }, [cronCreate.mutate, cronDelete.mutate, refetch]);

  // LOCAL-MODE freshness: the `crons` collection is pull-only (no stream), so a
  // cron created/triggered anywhere after load — e.g. by the CLI or a workflow —
  // is never pushed here. Poll the small `cronList` RPC on a modest interval
  // (+ on focus/visibility) so `/crons` reflects an out-of-band change within
  // ~LOCAL_LIST_POLL_MS, no reload needed. Local-mode only; the cloud path
  // streams via Electric (P5) and this poll is removed there.
  useLocalModeRefetch(refetch);

  useEffect(() => {
    useCronsStore.setState((state) => {
      const crons = data ? data.map(toCron) : [];
      // Keep the selection across reconciles. A toggle is delete+recreate, which
      // mints a NEW cronId for the same workflow+pattern, so when the exact id is
      // gone we re-bind to the cron with the same workflow+pattern rather than
      // dropping the user's selection mid-toggle.
      const prior = state.crons.find((cron) => cron.id === state.selectedId) ?? null;
      let selectedId: string | null = null;
      if (state.selectedId && crons.some((cron) => cron.id === state.selectedId)) {
        selectedId = state.selectedId;
      } else if (prior) {
        const reborn = crons.find(
          (cron) => cron.workflowPath === prior.workflowPath && cron.pattern === prior.pattern,
        );
        selectedId = reborn?.id ?? null;
      }
      return { crons, selectedId };
    });
  }, [data]);

  return null;
}

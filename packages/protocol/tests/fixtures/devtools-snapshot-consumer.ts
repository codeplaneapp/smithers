import type { DevToolsRunState, DevToolsSnapshot } from "@smthrs/protocol";

declare const snapshot: DevToolsSnapshot;

if (snapshot.runState) {
  const state: DevToolsRunState["state"] = snapshot.runState.state;
  const blockedKind: string | undefined = snapshot.runState.blocked?.kind;
  const unhealthyKind: string | undefined = snapshot.runState.unhealthy?.kind;
  const computedAt: string = snapshot.runState.computedAt;
  void [state, blockedKind, unhealthyKind, computedAt];
}

const quotaState: DevToolsRunState = {
  runId: "run-consumer",
  state: "waiting-quota",
  blocked: { kind: "quota", quotaBlockedCount: 2, resetAtMs: 1_700_000_000_000 },
  computedAt: "2026-07-13T00:00:00.000Z",
};

void quotaState;

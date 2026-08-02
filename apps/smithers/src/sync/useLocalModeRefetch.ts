import { useEffect } from "react";

/**
 * The local-mode list-freshness poll interval, in milliseconds.
 *
 * WHY THIS EXISTS (local-mode freshness strategy):
 * The shipped `runs` and `approvals` gateway collections are PULL-ONLY — unlike
 * `run`/`nodes`/`runEvents`, their collection defs carry NO `stream` (see
 * `@smthrs/gateway-client` `gatewayCollectionDefs.ts`). So a run
 * launched, a gate reached, or an approval resolved ANYWHERE after the initial
 * pull is never pushed into these list collections — the list would otherwise go
 * stale mid-session until a reload. The master design
 * (`docs/real-data-electric-design.md` §1 rule 2) explicitly relaxes local-mode
 * liveness: true streaming is the cloud/Electric path (P5), and local mode uses
 * an honest refetch instead of a fan-out stream.
 *
 * P5 REMOVAL ANCHOR: when the Electric/cloud streaming path lands, this poll is
 * removed/replaced by the streamed list collection. Grep `LOCAL_LIST_POLL_MS`
 * (and `useLocalModeRefetch`) to find every poll site to retire.
 */
export const LOCAL_LIST_POLL_MS = 2500;

/**
 * Drive a single local-mode freshness loop for a pull-only list collection.
 *
 * Calls `refetch()` on a modest interval (`LOCAL_LIST_POLL_MS`) while mounted,
 * AND immediately on `window` `focus` + a `visibilitychange` that returns the
 * tab to visible (so a backgrounded tab re-syncs the instant the user returns,
 * rather than waiting out the interval). All listeners + the interval are torn
 * down on unmount.
 *
 * ONE interval per call site by contract: mount this once per bridge (the runs
 * list, the approvals queue) — never per row — so a single-user local app polls
 * at most two small list RPCs every `LOCAL_LIST_POLL_MS`, which is negligible.
 * This is the LOCAL-MODE mechanism only; the cloud path streams via Electric
 * (P5) and this hook is removed there (see `LOCAL_LIST_POLL_MS`).
 */
export function useLocalModeRefetch(refetch: () => Promise<void> | void): void {
  useEffect(() => {
    const tick = () => {
      void refetch();
    };

    const interval = setInterval(tick, LOCAL_LIST_POLL_MS);

    const onFocus = () => tick();
    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refetch]);
}

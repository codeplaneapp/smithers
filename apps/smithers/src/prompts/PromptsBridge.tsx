import { useEffect } from "react";
import { useGatewayPrompts } from "@smithers-orchestrator/gateway-react";
import type { GatewayPromptRow } from "@smithers-orchestrator/gateway-client";
import { useLocalModeRefetch } from "../sync/useLocalModeRefetch";
import { useGatewayConnectionStatus } from "../sync/useGatewayConnectionStatus";
import { OFFLINE_SEED_PROMPTS, type Prompt } from "./promptsSource";
import { usePromptsStore } from "./promptsStore";

/**
 * Bridge the live `prompts` gateway collection into the prompts-editor store
 * (P1b §3.5). The Zustand store can't call React hooks, so this component —
 * mounted inside `SmithersCollectionsProvider` in `main.tsx` next to the other
 * surface bridges. It calls `useGatewayPrompts()`, maps each `GatewayPromptRow` onto a
 * `Prompt`, and pushes the result into the store on every change. Prompts are
 * READ-ONLY on the wire (only a `listPrompts` RPC, no write), so there is no
 * mutation seam: the gateway enumerates the `.smithers/prompts/**.{md,mdx}`
 * files on disk and they surface here verbatim. The editor's local `save` stays
 * an optimistic in-memory action (chat line + toast), as it already is.
 */

/**
 * Map a live `GatewayPromptRow` onto the surface's `Prompt`. The wire carries
 * exactly the fields the editor needs ({id, entryFile, source}); the optional
 * timestamps are not surfaced (the editor discovers inputs/imports/preview from
 * `source`, not from metadata).
 */
export function toPrompt(row: GatewayPromptRow): Prompt {
  return { id: row.id, entryFile: row.entryFile, source: row.source };
}

export function PromptsBridge() {
  const { data, loading, refetch } = useGatewayPrompts();
  const connection = useGatewayConnectionStatus();

  // LOCAL-MODE freshness: the `prompts` collection is pull-only (no stream), so a
  // prompt file added/edited on disk after load is never pushed here. Poll the
  // small `listPrompts` RPC on a modest interval (+ on focus/visibility) so
  // `/prompts` reflects an out-of-band change within ~LOCAL_LIST_POLL_MS, no
  // reload needed. Local-mode only; the cloud path streams via Electric (P5) and
  // this poll is removed there.
  useLocalModeRefetch(refetch);

  useEffect(() => {
    // OFFLINE FALLBACK (graceful degradation, NOT demo data): when the gateway
    // link is unreachable AND we have no live rows yet, show the offline seed so
    // `/prompts` is browsable instead of an empty view. The moment the live RPC
    // resolves — even to an empty list — the live rows (or a clean empty state)
    // replace the fallback. `loading` keeps us from flashing the fallback during
    // the very first in-flight pull on an online link.
    const live = data ?? [];
    const useOffline = connection.status === "offline" && live.length === 0 && !loading;
    const rows: Prompt[] = useOffline ? OFFLINE_SEED_PROMPTS.slice() : live.map(toPrompt);

    usePromptsStore.setState((state) => {
      // Keep the selection across reconciles; otherwise pick the first row so the
      // editor opens on a real prompt. A vanished selection can never strand the
      // UI on a blank detail pane.
      const selectedId =
        state.selectedId && rows.some((prompt) => prompt.id === state.selectedId)
          ? state.selectedId
          : (rows[0]?.id ?? "");
      return { prompts: rows, selectedId };
    });
  }, [data, loading, connection.status]);

  return null;
}

import { create } from "zustand";
import { useChatStore } from "../chat/chatStore";
import { useNotificationsStore } from "../notifications/notificationsStore";
import {
  normalizeRunId,
  resolveActiveRunId,
  runLabel,
  shortRunId,
  type ScoresRun,
  type ScoreSample,
} from "./scoreReport";

/** The three Summary/Metrics/Recent tabs the canvas toggles between. */
export type ScoreTab = "summary" | "metrics" | "recent";

/**
 * The real RPC seam the `ScoresBridge` installs: a `refetch` that re-pulls the
 * active run's `listScores` collection. The Zustand store can't call React
 * hooks, so the bridge binds the live `useGatewayScores(...).refetch` here and
 * `refresh()` drives it. Null until the bridge mounts (refresh is then a no-op
 * beyond its chat/toast feedback).
 */
type ScoresActions = { refetch: () => void };
let boundActions: ScoresActions | null = null;
export function bindScoresActions(actions: ScoresActions): void {
  boundActions = actions;
}

/**
 * The scores store: the LIVE run roster (from `useGatewayRuns` via the bridge),
 * the LIVE scorer rows for the active run (from `useGatewayScores`), plus the
 * selected run and active tab the card and canvas read. `selectedRunId` is null
 * until a run is picked and resolves to the first run via resolveActiveRunId. The
 * derived per-run metrics are NOT held here — the canvas computes them ON-DEMAND
 * from `scoreRows` (Path A), so all tabs stay in sync off one row set.
 *
 * `refresh` re-pulls the live collection (the bound RPC) and echoes a chat line +
 * transient toast, the same feedback shape the vcs/issues stores use.
 */
type ScoresState = {
  runs: ScoresRun[];
  scoreRows: ScoreSample[];
  selectedRunId: string | null;
  tab: ScoreTab;
  setTab: (tab: ScoreTab) => void;
  selectRun: (runId: string) => void;
  refresh: () => void;
};

export const useScoresStore = create<ScoresState>((set, get) => ({
  runs: [],
  scoreRows: [],
  selectedRunId: null,
  tab: "summary",

  setTab: (tab) => set({ tab }),

  selectRun: (runId) => {
    const next = normalizeRunId(runId);
    if (next === get().selectedRunId) return;
    set({ selectedRunId: next });
  },

  refresh: () => {
    boundActions?.refetch();
    const { runs, selectedRunId } = get();
    const active = resolveActiveRunId(runs, selectedRunId);
    if (active == null) {
      useChatStore.getState().say("No runs available to score.");
      return;
    }
    const run = runs.find((candidate) => candidate.runId === active);
    const label = run ? runLabel(run) : `Run ${shortRunId(active)}`;
    useChatStore.getState().say(`Refreshed scores for ${label}.`);
    useNotificationsStore.getState().notify({
      title: "Scores refreshed",
      detail: label,
      kind: "transient",
      command: "chat",
    });
  },
}));

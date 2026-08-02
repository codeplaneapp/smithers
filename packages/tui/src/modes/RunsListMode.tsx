import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import {
  RunsListBridge,
  useRunsListVm,
  runDisplayName,
  runStatusToNode,
  type RunSummary,
  type RunStatusFilter,
} from "@smthrs/ui-core";
import { sanitizeTerminalText, StatusGlyph } from "@smthrs/tui-ui";
import { isModifiedKeyEvent } from "./treeUtils.ts";
import { useOverlayOpen } from "../OverlayContext.tsx";

const COMPACT_WIDTH = 100;

/**
 * Runs search is a text-capture mode. OpenTUI keyboard listeners are
 * independent, so the app-level listener must be told to suspend global
 * bindings while this mode consumes printable input.
 */
export const TextInputCaptureContext = createContext<(captured: boolean) => void>(() => {});

/** `f`'s status-filter cycle order (research/tui-parity/03-tui-screens.md
 *  "Runs list"). Starts and ends on "all" so repeated presses loop. */
const STATUS_FILTER_CYCLE: RunStatusFilter[] = ["all", "running", "waiting", "finished", "failed", "cancelled"];

export function nextStatusFilter(current: RunStatusFilter): RunStatusFilter {
  const idx = STATUS_FILTER_CYCLE.indexOf(current);
  return STATUS_FILTER_CYCLE[(idx + 1) % STATUS_FILTER_CYCLE.length]!;
}

export function flattenRunGroups(groups: ReadonlyArray<{ runs: readonly RunSummary[] }>): RunSummary[] {
  return groups.flatMap((group) => group.runs);
}

/**
 * The runs list mode (research/tui-parity/03-tui-screens.md "Runs list"):
 * `useRunsListVm` over the live `runs` gateway collection + `runsList.ts`'s
 * filter/group/summarize reducers. `RunsListBridge` is the headless
 * null-rendering pump (mirrors multi's `<RunsListBridge />`) — mounted here
 * rather than once near the app root, since it is the only mode that needs
 * the roster; unmounting it when the mode isn't active just means the store
 * goes stale until the mode is re-entered, which re-hydrates it immediately.
 */
export function RunsListMode({ onSelectRun }: { onSelectRun: (runId: string) => void }) {
  return (
    <>
      <RunsListBridge />
      <RunsListView onSelectRun={onSelectRun} />
    </>
  );
}

/**
 * Presentational runs list. Reads the view model directly (no gateway hooks
 * of its own) so it renders deterministically once the store is seeded —
 * mirrors LogView/TreePanel's split between a thin gateway wrapper and a pure
 * view.
 */
export function RunsListView({ onSelectRun }: { onSelectRun: (runId: string) => void }) {
  const vm = useRunsListVm();
  const overlayOpen = useOverlayOpen();
  const setTextInputCaptured = useContext(TextInputCaptureContext);
  const { width } = useTerminalDimensions();
  const compact = width < COMPACT_WIDTH;

  // Flat, group-ordered roster so j/k walk the same rows the sections render
  // (groups.flatMap preserves ACTIVE/COMPLETED/FAILED/CANCELLED order).
  const rows: RunSummary[] = useMemo(() => flattenRunGroups(vm.groups), [vm.groups]);
  const [focusIdx, setFocusIdx] = useState(0);
  const clampedFocusIdx = rows.length === 0 ? 0 : Math.min(focusIdx, rows.length - 1);

  // `/` composer-first exception (mirrors chat home's rule in
  // research/tui-parity/03-tui-screens.md's Keymap): while searching, every
  // printable key edits the search text instead of navigating rows.
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    setTextInputCaptured(searching);
    return () => setTextInputCaptured(false);
  }, [searching, setTextInputCaptured]);

  useKeyboard((e) => {
    if (overlayOpen || isModifiedKeyEvent(e)) return;

    if (searching) {
      if (e.name === "return" || e.name === "escape") {
        setSearching(false);
      } else if (e.name === "backspace" || e.name === "delete") {
        vm.setSearch(vm.filters.search.slice(0, -1));
      } else if (e.sequence && e.sequence.length === 1 && e.sequence >= " ") {
        vm.setSearch(vm.filters.search + e.sequence);
      }
      return;
    }

    if (e.name === "f") {
      setFocusIdx(0);
      vm.setStatusFilter(nextStatusFilter(vm.filters.status));
      return;
    }
    if (e.name === "/") {
      setSearching(true);
      return;
    }

    if (rows.length === 0) return;
    if (e.name === "j" || e.name === "down") {
      setFocusIdx(Math.min(clampedFocusIdx + 1, rows.length - 1));
    } else if (e.name === "k" || e.name === "up") {
      setFocusIdx(Math.max(clampedFocusIdx - 1, 0));
    } else if (e.name === "return") {
      const row = rows[clampedFocusIdx];
      if (row) onSelectRun(row.runId);
    }
  });

  if (!vm.rosterHydrated) {
    return (
      <box width="100%" height="100%">
        <text fg="#555555">{"  Loading runs…"}</text>
      </box>
    );
  }

  const filterHint = compact
    ? `[f] filter:${vm.filters.status}  [/] search`
    : `[f] filter status (${vm.filters.status})   [/] search`;
  const filterBar = searching ? (
    <box width="100%" height={1} flexDirection="row">
      <text fg="#ffaf00">{`  /${vm.filters.search}`}</text>
      <text fg="#555555">{"_"}</text>
    </box>
  ) : (
    <box width="100%" height={1} flexDirection="row">
      <text fg="#555555">{`  ${filterHint}`}</text>
      {vm.filters.search ? <text fg="#888888">{`  search:"${vm.filters.search}"`}</text> : null}
      {vm.hasActiveFilters ? <text fg="#00d7ff">{"  (filtered)"}</text> : null}
    </box>
  );

  if (rows.length === 0) {
    return (
      <box width="100%" height="100%" flexDirection="column">
        {filterBar}
        <box width="100%" flexGrow={1} alignItems="center" justifyContent="center">
          <text fg="#cccccc">{vm.hasActiveFilters ? "No runs match this filter" : "No runs yet"}</text>
        </box>
      </box>
    );
  }

  let rowCursor = 0;

  return (
    <box width="100%" height="100%" flexDirection="column">
      <box width="100%" height={1} flexDirection="row">
        <text fg="#555555">{`  RUNS  ${vm.summary.total} total`}</text>
        <text fg="#00d7ff">{`  ${vm.summary.active} active`}</text>
        <text fg="#00d787">{`  ${vm.summary.done} done`}</text>
        {vm.summary.failed > 0 ? <text fg="#ff5f5f">{`  ${vm.summary.failed} failed`}</text> : null}
      </box>
      {filterBar}
      <scrollbox width="100%" flexGrow={1} scrollY>
        {vm.groups.map((group) => {
          const groupStart = rowCursor;
          rowCursor += group.runs.length;
          return (
            <box key={group.key} width="100%" flexDirection="column">
              <text fg="#555555">{`  ${group.label}`}</text>
              {group.runs.map((run, i) => {
                const idx = groupStart + i;
                const isFocused = idx === clampedFocusIdx;
                const label = sanitizeTerminalText(runDisplayName(run));
                const maxLabelWidth = compact ? 32 : 60;
                const truncLabel = label.length > maxLabelWidth ? `${label.slice(0, maxLabelWidth - 1)}…` : label;
                return (
                  <box
                    key={run.id}
                    width="100%"
                    height={1}
                    flexDirection="row"
                    backgroundColor={isFocused ? "#1a1a2e" : undefined}
                  >
                    <text> </text>
                    <StatusGlyph status={runStatusToNode(run.status)} />
                    <text> </text>
                    <text fg={isFocused ? "#ffffff" : "#cccccc"}>{truncLabel}</text>
                    <text fg="#555555">{`  ${run.elapsedLabel}`}</text>
                  </box>
                );
              })}
            </box>
          );
        })}
      </scrollbox>
    </box>
  );
}

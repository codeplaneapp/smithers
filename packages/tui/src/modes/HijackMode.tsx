import { useState, useEffect, useRef } from "react";
import { useKeyboard } from "@opentui/react";
import { spawn } from "node:child_process";
import { useRunTree, useRunEvents, TUI_EVENT_CAP } from "../data.ts";
import { useRenderer } from "../RendererContext.tsx";
import { useOverlayOpen } from "../OverlayContext.tsx";
import { resolveCliEntry } from "../cliEntry.ts";
import { isModifiedKeyEvent } from "./treeUtils.ts";
import { runNodeKey, type GatewayRunNode } from "@smithers-orchestrator/gateway-client";
import {
  hijackCandidates,
  nodeSelectOption,
  hijackExitMessage,
  startHijackSession,
  SUPPORTS_PROCESS_GROUPS,
} from "./hijackUtils.ts";

type Phase = "selecting" | "handing-off" | "returned";

/**
 * Build the `smithers hijack` invocation for a specific node, run through the
 * REAL CLI entry (SMITHERS_CLI or the resolved `@smithers-orchestrator/cli`
 * package) — never a bare `smithers` on PATH, which could be stale or missing.
 * Returns null when no CLI entry can be resolved so the caller can surface a
 * clear error instead of guessing. `--target` scopes the hijack to the selected
 * node (resolveHijackCandidate matches it against the attempt's nodeId), so the
 * right agent session is handed off.
 */
export function hijackCommand(
  runId: string,
  nodeId: string,
  // Injectable so the "no CLI entry" branch is exercisable in a repo where the
  // CLI package always resolves. Production passes nothing.
  resolveCli: () => string | null = resolveCliEntry,
): { command: string; args: string[] } | null {
  const cliPath = resolveCli();
  if (!cliPath) return null;
  return { command: process.argv[0] ?? "bun", args: [cliPath, "hijack", runId, "--target", nodeId] };
}

export function Selecting({
  nodes,
  onSelect,
  onCancel,
}: {
  nodes: GatewayRunNode[];
  onSelect: (node: GatewayRunNode) => void;
  onCancel: () => void;
}) {
  const selectOptions = nodes.map(nodeSelectOption);
  const overlayOpen = useOverlayOpen();

  useKeyboard((e) => {
    if (overlayOpen || isModifiedKeyEvent(e)) return;
    if (e.name === "escape") onCancel();
  });

  return (
    <box width="100%" height="100%" flexDirection="column">
      <box width="100%" height={2} flexDirection="column">
        <text fg="#ffaf00">  HIJACK — select a running node to hand off to</text>
        <text fg="#555555">  j/k or arrows to navigate  ↵ confirm  Esc cancel</text>
      </box>
      <select
        // The renderer focus system routes keys straight to a focused select,
        // bypassing useKeyboard — release focus while the help overlay is open
        // so j/k can't move the picker underneath it.
        focused={!overlayOpen}
        options={selectOptions}
        width="100%"
        flexGrow={1}
        showDescription={true}
        focusedBackgroundColor="#1a1a2e"
        focusedTextColor="#ffaf00"
        selectedBackgroundColor="#2a1a0e"
        selectedTextColor="#ffffff"
        onSelect={(_, opt) => {
          if (!opt) return;
          // Resolve by the unique row key the option carries (see
          // nodeSelectOption), so the exact attempt the user highlighted is the
          // one handed off — not the first row that shares its logical id.
          const node = nodes.find((n) => runNodeKey(n) === opt.value);
          if (node) onSelect(node);
        }}
      />
    </box>
  );
}

export function HandingOff({
  runId,
  node,
  onDone,
  resolveCli = resolveCliEntry,
}: {
  runId: string;
  node: GatewayRunNode;
  onDone: (code: number | null) => void;
  resolveCli?: () => string | null;
}) {
  const renderer = useRenderer();
  const nodeId = node.id;

  // `onDone` is a fresh closure each render, but re-running the spawn effect for
  // it would kill the live hijack child and respawn it. Read the latest callback
  // through a ref so the effect can depend only on the values that actually
  // define the child (runId/nodeId/renderer) without going stale.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const cmd = hijackCommand(runId, nodeId, resolveCli);
    if (!cmd) {
      // No CLI entry resolvable — can't hand off. Surface as an error exit
      // rather than guessing a `smithers` on PATH.
      onDoneRef.current(null);
      return;
    }
    // Suspend the renderer, spawn the hijack child, and restore on every exit
    // path; the returned cleanup kills the child (whole process group on POSIX)
    // and resumes if we unmount mid-session. stdio is inherited so the agent CLI
    // owns the real terminal while suspended; detached forms the killable group.
    return startHijackSession({
      renderer,
      spawnChild: () =>
        spawn(cmd.command, cmd.args, { stdio: "inherit", detached: SUPPORTS_PROCESS_GROUPS }),
      onDone: (code) => onDoneRef.current(code),
    });
  }, [runId, nodeId, renderer]);

  return (
    <box width="100%" height="100%">
      <text fg="#ffaf00">  Handing off to smithers hijack {runId} ({node.name ?? node.id})…</text>
    </box>
  );
}

export function Returned({
  node,
  exitCode,
  onDismiss,
}: {
  node: GatewayRunNode;
  exitCode: number | null;
  onDismiss: () => void;
}) {
  const overlayOpen = useOverlayOpen();
  useKeyboard((e) => {
    if (overlayOpen || isModifiedKeyEvent(e)) return;
    if (e.name === "d" || e.name === "escape" || e.name === "return") onDismiss();
  });

  // `smithers hijack` itself returns control to Smithers (resumes the run) when
  // the session exits cleanly on a live run, so there is nothing for the TUI to
  // "resume" — say what actually happened instead of offering a fake action.
  const resumedNote =
    exitCode === 0
      ? "Smithers automation resumed (handled by hijack on clean exit)."
      : "Run left as-is — re-run hijack to retry the hand-off.";

  return (
    <box width="100%" height="100%" flexDirection="column" justifyContent="center" alignItems="center">
      <box
        width={64}
        height={6}
        flexDirection="column"
        border={true}
        borderColor="#00d7ff"
      >
        <text fg="#00d7ff">  Returned from hijack: {node.name ?? node.id}</text>
        <text fg="#888888">  {hijackExitMessage(exitCode)}</text>
        <text fg="#888888">  {resumedNote}</text>
        <text> </text>
        <text fg="#ffffff">  [d] dismiss</text>
      </box>
    </box>
  );
}

export function HijackMode({
  runId,
  onBack,
  resolveCli = resolveCliEntry,
}: {
  runId: string;
  onBack?: () => void;
  resolveCli?: () => string | null;
}) {
  const { nodes } = useRunTree(runId);
  const { events } = useRunEvents(runId, { maxEvents: TUI_EVENT_CAP });
  // Tree status flattens non-root nodes to queued, so combine it with the
  // event-derived live-session signal to find every hijackable node.
  const candidates = hijackCandidates(nodes, events);
  const [phase, setPhase] = useState<Phase>("selecting");
  const [selectedNode, setSelectedNode] = useState<GatewayRunNode | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);

  // Hijack runs through the real CLI; without a resolvable entry it can't work,
  // so say so plainly instead of offering a hand-off that would fail.
  if (resolveCli() === null) {
    return (
      <box width="100%" height="100%" flexDirection="column">
        <text fg="#ff5f5f">  HIJACK unavailable — cannot resolve the smithers CLI.</text>
        <text fg="#555555">  Set SMITHERS_CLI or launch the monitor via `smithers up --interactive`.</text>
      </box>
    );
  }

  // Render the non-selecting phases off the already-selected node + phase state
  // FIRST, BEFORE consulting `candidates`. Once a hijack is handing-off (or has
  // returned), live event/candidate churn — including `candidates` recomputing
  // to empty — must NOT unmount HandingOff, run its cleanup, and kill the active
  // hijack child. `candidates` is only relevant while we are still selecting.
  if (phase === "handing-off" && selectedNode) {
    return (
      <HandingOff
        runId={runId}
        node={selectedNode}
        resolveCli={resolveCli}
        onDone={(code) => {
          setExitCode(code);
          setPhase("returned");
        }}
      />
    );
  }

  if (phase === "returned" && selectedNode) {
    return (
      <Returned
        node={selectedNode}
        exitCode={exitCode}
        onDismiss={() => {
          setPhase("selecting");
          setSelectedNode(null);
          setExitCode(null);
        }}
      />
    );
  }

  // phase === "selecting": only here does the candidate list (and its empty
  // state) drive what we render.
  if (candidates.length === 0) {
    return (
      <box width="100%" height="100%">
        <text fg="#555555">  HIJACK — no running nodes available to hand off to</text>
      </box>
    );
  }

  return (
    <Selecting
      nodes={candidates}
      onSelect={(node) => {
        setSelectedNode(node);
        setPhase("handing-off");
      }}
      onCancel={() => onBack?.()}
    />
  );
}

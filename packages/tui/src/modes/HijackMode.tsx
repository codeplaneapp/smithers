import { useState, useEffect, useRef } from "react";
import { useKeyboard } from "@opentui/react";
import { spawn } from "node:child_process";
import { useRunTree, useRunEvents } from "../data.ts";
import { useRenderer } from "../RendererContext.tsx";
import { resolveCliEntry } from "../cliEntry.ts";
import type { GatewayRunNode } from "@smithers-orchestrator/gateway-client";
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
function hijackCommand(runId: string, nodeId: string): { command: string; args: string[] } | null {
  const cliPath = resolveCliEntry();
  if (!cliPath) return null;
  return { command: process.argv[0] ?? "bun", args: [cliPath, "hijack", runId, "--target", nodeId] };
}

function Selecting({
  nodes,
  onSelect,
  onCancel,
}: {
  nodes: GatewayRunNode[];
  onSelect: (node: GatewayRunNode) => void;
  onCancel: () => void;
}) {
  const selectOptions = nodes.map(nodeSelectOption);

  useKeyboard((e) => {
    if (e.name === "escape") onCancel();
  });

  return (
    <box width="100%" height="100%" flexDirection="column">
      <box width="100%" height={2} flexDirection="column">
        <text fg="#ffaf00">  HIJACK — select a running node to hand off to</text>
        <text fg="#555555">  j/k or arrows to navigate  ↵ confirm  Esc cancel</text>
      </box>
      <select
        focused={true}
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
          const node = nodes.find((n) => n.id === opt.value);
          if (node) onSelect(node);
        }}
      />
    </box>
  );
}

function HandingOff({
  runId,
  node,
  onDone,
}: {
  runId: string;
  node: GatewayRunNode;
  onDone: (code: number | null) => void;
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
    const cmd = hijackCommand(runId, nodeId);
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

function Returned({
  node,
  exitCode,
  onDismiss,
}: {
  node: GatewayRunNode;
  exitCode: number | null;
  onDismiss: () => void;
}) {
  useKeyboard((e) => {
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
}: {
  runId: string;
  onBack?: () => void;
}) {
  const { nodes } = useRunTree(runId);
  const { events } = useRunEvents(runId, { maxEvents: 2000 });
  // Tree status flattens non-root nodes to queued, so combine it with the
  // event-derived live-session signal to find every hijackable node.
  const candidates = hijackCandidates(nodes, events);
  const [phase, setPhase] = useState<Phase>("selecting");
  const [selectedNode, setSelectedNode] = useState<GatewayRunNode | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);

  // Hijack runs through the real CLI; without a resolvable entry it can't work,
  // so say so plainly instead of offering a hand-off that would fail.
  if (resolveCliEntry() === null) {
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

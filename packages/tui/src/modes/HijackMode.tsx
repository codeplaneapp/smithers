import { useState, useEffect } from "react";
import { useKeyboard } from "@opentui/react";
import { spawn } from "node:child_process";
import { useRunTree } from "../data.ts";
import { useRenderer } from "../RendererContext.tsx";
import type { GatewayRunNode } from "@smithers-orchestrator/gateway-client";
import { runningNodes, nodeSelectOption, hijackExitMessage } from "./hijackUtils.ts";

type Phase = "selecting" | "handing-off" | "returned";

function spawnHijack(runId: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn("smithers", ["hijack", runId], { stdio: "inherit" });
    child.on("close", (code) => resolve(code));
    child.on("error", () => resolve(null));
  });
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

  useEffect(() => {
    let alive = true;
    (async () => {
      renderer.suspend();
      const code = await spawnHijack(runId);
      renderer.resume();
      if (alive) onDone(code);
    })();
    return () => {
      alive = false;
    };
  }, [runId, node.id]);

  return (
    <box width="100%" height="100%">
      <text fg="#ffaf00">  Handing off to smithers hijack {runId}…</text>
    </box>
  );
}

function Returned({
  node,
  exitCode,
  onResume,
  onDismiss,
}: {
  node: GatewayRunNode;
  exitCode: number | null;
  onResume: () => void;
  onDismiss: () => void;
}) {
  useKeyboard((e) => {
    if (e.name === "a") onResume();
    else if (e.name === "d" || e.name === "escape") onDismiss();
  });

  return (
    <box width="100%" height="100%" flexDirection="column" justifyContent="center" alignItems="center">
      <box
        width={60}
        height={5}
        flexDirection="column"
        border={true}
        borderColor="#00d7ff"
      >
        <text fg="#00d7ff">  Returned from hijack: {node.name ?? node.id}</text>
        <text fg="#888888">  {hijackExitMessage(exitCode)}</text>
        <text> </text>
        <text fg="#ffffff">  [a] resume automation   [d] dismiss</text>
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
  const running = runningNodes(nodes);
  const [phase, setPhase] = useState<Phase>("selecting");
  const [selectedNode, setSelectedNode] = useState<GatewayRunNode | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);

  if (running.length === 0) {
    return (
      <box width="100%" height="100%">
        <text fg="#555555">  HIJACK — no running nodes available to hand off to</text>
      </box>
    );
  }

  if (phase === "selecting") {
    return (
      <Selecting
        nodes={running}
        onSelect={(node) => {
          setSelectedNode(node);
          setPhase("handing-off");
        }}
        onCancel={() => onBack?.()}
      />
    );
  }

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
        onResume={() => onBack?.()}
        onDismiss={() => {
          setPhase("selecting");
          setSelectedNode(null);
          setExitCode(null);
        }}
      />
    );
  }

  return null;
}

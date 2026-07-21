/** @jsxImportSource react */
import { useState } from "react";
import { useGatewayActions } from "@smithers-orchestrator/gateway-react";
import {
  Checkpoint,
  CheckpointActions,
  CheckpointIcon,
  CheckpointMetadata,
  type CheckpointActionKind,
  type CheckpointModel,
} from "@smithers-orchestrator/ui";

export type GatewayCheckpointControlsProps = {
  runId: string;
  /**
   * Checkpoints to render. gateway-react exposes no snapshot-list hook, so
   * hosts derive these from run events / CLI data and pass them in.
   */
  checkpoints: readonly CheckpointModel[];
  /** The live frame number; marks the matching checkpoint as current. */
  currentFrameNo?: number;
  /**
   * Host handler for non-rewind kinds (restore/fork/replay/return-to-live).
   * Those actions render ONLY when this is provided — no fabricated
   * capabilities.
   */
  onAction?: (
    kind: Exclude<CheckpointActionKind, "rewind">,
    checkpoint: CheckpointModel,
  ) => void | Promise<void>;
  /** Called after a native rewindRun resolves. */
  onRewound?: (frameNo: number) => void;
  className?: string;
};

/**
 * Checkpoint list wired to the gateway. Only `rewind` is implemented natively
 * (the gateway surface exposes only `rewindRun({ runId, frameNo, confirm:
 * true })`); rewind is disabled for checkpoints without a frameNo. Every other
 * action kind is forwarded to the host's `onAction` and renders only when that
 * prop is provided.
 */
export function GatewayCheckpointControls({
  runId,
  checkpoints,
  currentFrameNo,
  onAction,
  onRewound,
  className,
}: GatewayCheckpointControlsProps) {
  const actions = useGatewayActions();
  const [busy, setBusy] = useState<{ id: string; kind: CheckpointActionKind } | null>(null);

  async function handleAction(kind: CheckpointActionKind, checkpoint: CheckpointModel) {
    if (busy !== null) return;
    if (kind === "rewind") {
      if (checkpoint.frameNo === undefined) return;
      setBusy({ id: checkpoint.id, kind });
      try {
        await actions.rewindRun({ runId, frameNo: checkpoint.frameNo, confirm: true });
        onRewound?.(checkpoint.frameNo);
      } finally {
        setBusy(null);
      }
      return;
    }
    if (onAction === undefined) return;
    setBusy({ id: checkpoint.id, kind });
    try {
      await onAction(kind, checkpoint);
    } finally {
      setBusy(null);
    }
  }

  const renderedActions: readonly CheckpointActionKind[] =
    onAction === undefined ? ["rewind"] : ["restore", "fork", "replay", "rewind", "return-to-live"];

  return (
    <div className={className}>
      {checkpoints.map((checkpoint) => {
        const rowBusy = busy?.id === checkpoint.id ? busy.kind : null;
        const rowDisabled: readonly CheckpointActionKind[] | undefined =
          busy !== null && rowBusy === null
            ? renderedActions
            : checkpoint.frameNo === undefined
              ? ["rewind"]
              : undefined;
        return (
          <Checkpoint
            key={checkpoint.id}
            checkpoint={checkpoint}
            current={currentFrameNo !== undefined && checkpoint.frameNo === currentFrameNo}
          >
            <CheckpointIcon />
            <span className="sui-checkpoint-label">{checkpoint.label ?? checkpoint.id}</span>
            <CheckpointMetadata />
            <CheckpointActions
              actions={renderedActions}
              busy={rowBusy}
              disabled={rowDisabled}
              onAction={(kind) => void handleAction(kind, checkpoint)}
            />
          </Checkpoint>
        );
      })}
    </div>
  );
}

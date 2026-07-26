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
  onAction?: (kind: Exclude<CheckpointActionKind, "rewind">, checkpoint: CheckpointModel) => void | Promise<void>;
  /** Called with a normalized Error if rewindRun or onAction rejects. */
  onError?: (error: Error) => void;
  /** Called after a native rewindRun resolves. */
  onRewound?: (frameNo: number) => void;
  className?: string;
};

/**
 * Checkpoint list wired to the gateway. Only `rewind` is implemented natively
 * (the gateway surface exposes only `rewindRun({ runId, frameNo, confirm:
 * true })`); rewind is disabled for checkpoints without a frameNo. Every other
 * action kind is forwarded to the host's `onAction` and renders only when that
 * prop is provided. A rejected rewindRun or host onAction never escapes as an
 * unhandled rejection: the row shows a role="alert" failure note and every
 * action re-enables once the attempt settles. A throwing onRewound observer
 * never converts a successful rewind into a row failure.
 */
export function GatewayCheckpointControls({
  runId,
  checkpoints,
  currentFrameNo,
  onAction,
  onError,
  onRewound,
  className,
}: GatewayCheckpointControlsProps) {
  const actions = useGatewayActions();
  const [busy, setBusy] = useState<{ id: string; kind: CheckpointActionKind } | null>(null);
  const [failures, setFailures] = useState<Map<string, { id: string; kind: CheckpointActionKind; message: string }>>(
    () => new Map(),
  );

  function failAction(kind: CheckpointActionKind, checkpoint: CheckpointModel, cause: unknown) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    setFailures((current) => {
      const next = new Map(current);
      next.set(checkpoint.id, { id: checkpoint.id, kind, message: error.message });
      return next;
    });
    try {
      onError?.(error);
    } catch {
      // Error observers must not turn a handled action failure into a rejection.
    }
  }

  // Never lets a rejection escape: every failure path lands in the latest
  // checkpoint entry in `failures`, which renders a role="alert" note.
  async function handleAction(kind: CheckpointActionKind, checkpoint: CheckpointModel) {
    if (busy !== null) return;
    if (kind === "rewind") {
      if (checkpoint.frameNo === undefined) return;
      setFailures((current) => {
        if (!current.has(checkpoint.id)) return current;
        const next = new Map(current);
        next.delete(checkpoint.id);
        return next;
      });
      setBusy({ id: checkpoint.id, kind });
      try {
        await actions.rewindRun({ runId, frameNo: checkpoint.frameNo, confirm: true });
      } catch (cause) {
        failAction(kind, checkpoint, cause);
        return;
      } finally {
        setBusy(null);
      }
      // Observer isolation: a consumer onRewound throwing must not surface
      // as a row failure — the rewind already succeeded.
      try {
        onRewound?.(checkpoint.frameNo);
      } catch {
        /* observer fault — the rewind already succeeded */
      }
      return;
    }
    if (onAction === undefined) return;
    setFailures((current) => {
      if (!current.has(checkpoint.id)) return current;
      const next = new Map(current);
      next.delete(checkpoint.id);
      return next;
    });
    setBusy({ id: checkpoint.id, kind });
    try {
      await onAction(kind, checkpoint);
    } catch (cause) {
      failAction(kind, checkpoint, cause);
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
        const rowFailure = failures.get(checkpoint.id) ?? null;
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
            {rowFailure !== null ? (
              <div data-slot="checkpoint-error" role="alert" className="sui-checkpoint-error">
                {rowFailure.kind[0]!.toUpperCase()}
                {rowFailure.kind.slice(1)} failed: {rowFailure.message}
              </div>
            ) : null}
          </Checkpoint>
        );
      })}
    </div>
  );
}

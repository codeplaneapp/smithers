/** @jsxImportSource react */
import { useInsertionEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useGatewayActions } from "@smithers-orchestrator/gateway-react";
import type { RunStartedBy } from "@smithers-orchestrator/gateway-client";
import { ensureGatewayUiStyles, theme } from "./theme";

export type LaunchButtonProps = {
  /** The workflow key to launch (must be registered on the gateway). */
  workflow: string;
  /** Input object passed to the run. */
  input?: Record<string, unknown>;
  /** Optional self-reported launch provenance forwarded as `options.startedBy`. */
  startedBy?: RunStartedBy;
  /** Button label. Defaults to "Launch <workflow>". */
  children?: ReactNode;
  /** Called with the new runId after a successful launch. */
  onLaunched?: (runId: string) => void;
  /** Called if the launch RPC throws. */
  onError?: (error: Error) => void;
  className?: string;
  style?: CSSProperties;
};

/**
 * A button that launches a workflow run via {@link useGatewayActions}. Disables
 * itself while the RPC is in flight and calls `onLaunched` with the new runId.
 */
export function LaunchButton({
  workflow,
  input,
  startedBy,
  children,
  onLaunched,
  onError,
  className,
  style,
}: LaunchButtonProps) {
  const actions = useGatewayActions();
  const [busy, setBusy] = useState(false);
  useInsertionEffect(ensureGatewayUiStyles, []);

  const launch = async () => {
    setBusy(true);
    try {
      const result = await actions.launchRun({
        workflow,
        ...(input ? { input } : {}),
        ...(startedBy ? { options: { startedBy } } : {}),
      });
      const runId = (result as { runId?: string } | undefined)?.runId;
      if (runId) onLaunched?.(runId);
    } catch (cause) {
      onError?.(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={["gw-launch-button", className].filter(Boolean).join(" ")}
      disabled={busy}
      aria-busy={busy}
      onClick={launch}
      style={{
        padding: "8px 16px",
        borderRadius: theme.radius,
        border: "none",
        background: theme.accent,
        color: "var(--inverse-text, #fafafa)",
        fontFamily: theme.fontSans,
        fontWeight: 600,
        fontSize: 13,
        ...style,
      }}
    >
      {children ?? (busy ? `Launching ${workflow}…` : `Launch ${workflow}`)}
    </button>
  );
}

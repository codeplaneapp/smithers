import { useState, type CSSProperties, type ReactNode } from "react";
import { useGatewayActions } from "@smithers-orchestrator/gateway-react";
import { theme } from "./theme";

export type LaunchButtonProps = {
  /** The workflow key to launch (must be registered on the gateway). */
  workflow: string;
  /** Input object passed to the run. */
  input?: Record<string, unknown>;
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
  children,
  onLaunched,
  onError,
  className,
  style,
}: LaunchButtonProps) {
  const actions = useGatewayActions();
  const [busy, setBusy] = useState(false);

  const launch = async () => {
    setBusy(true);
    try {
      const result = await actions.launchRun({ workflow, ...(input ? { input } : {}) });
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
      className={className}
      disabled={busy}
      onClick={launch}
      style={{
        padding: "8px 16px",
        borderRadius: theme.radius,
        border: "none",
        background: theme.accent,
        color: "#fff",
        fontFamily: theme.fontSans,
        fontWeight: 600,
        fontSize: 13,
        cursor: busy ? "default" : "pointer",
        opacity: busy ? 0.6 : 1,
        ...style,
      }}
    >
      {children ?? (busy ? `Launching ${workflow}…` : `Launch ${workflow}`)}
    </button>
  );
}

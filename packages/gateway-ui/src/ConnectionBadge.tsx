import type { CSSProperties } from "react";
import { useGatewayConnectionStatus } from "@smithers-orchestrator/gateway-react";
import { theme } from "./theme";

export type ConnectionBadgeProps = {
  className?: string;
  style?: CSSProperties;
};

const LABEL: Record<string, string> = {
  online: "Connected",
  offline: "Offline",
  unauthorized: "Unauthorized",
  idle: "Connecting…",
  connecting: "Connecting…",
};

const COLOR: Record<string, string> = {
  online: "#3fb950",
  offline: "#f85149",
  unauthorized: "#d29922",
};

/**
 * Live gateway connection indicator. Reads {@link useGatewayConnectionStatus},
 * which the gateway transport drives off real traffic (RPC resolves, stream
 * frames, transport errors). Drop it in a header to show whether the UI is
 * talking to the gateway.
 */
export function ConnectionBadge({ className, style }: ConnectionBadgeProps) {
  const { status } = useGatewayConnectionStatus();
  const color = COLOR[status] ?? theme.textDim;
  return (
    <span
      className={className}
      data-status={status}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontFamily: theme.fontSans,
        fontSize: 12,
        color: theme.textDim,
        ...style,
      }}
    >
      <span
        aria-hidden
        style={{ width: 8, height: 8, borderRadius: 999, background: color }}
      />
      {LABEL[status] ?? status}
    </span>
  );
}

/** @jsxImportSource react */
import type { CSSProperties } from "react";
import { useGatewayConnectionStatus } from "@smthrs/gateway-react";
import { Badge, type BadgeProps } from "@smthrs/ui";

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

const DESCRIPTION: Record<string, string> = {
  online: "Gateway connected.",
  offline: "Gateway connection lost. Displayed data may be last known.",
  unauthorized: "Gateway authentication failed. Check your credentials, then reconnect.",
  idle: "Connecting to the gateway.",
  connecting: "Connecting to the gateway.",
};

const VARIANT: Record<string, NonNullable<BadgeProps["variant"]>> = {
  online: "success",
  offline: "destructive",
  unauthorized: "warning",
  idle: "muted",
  connecting: "muted",
};

/**
 * Live gateway connection indicator. Reads {@link useGatewayConnectionStatus},
 * which the gateway transport drives off real traffic (RPC resolves, stream
 * frames, transport errors). Drop it in a header to show whether the UI is
 * talking to the gateway.
 */
export function ConnectionBadge({ className, style }: ConnectionBadgeProps) {
  const { status } = useGatewayConnectionStatus();
  return (
    <Badge
      variant={VARIANT[status] ?? "muted"}
      className={className}
      data-status={status}
      role="status"
      aria-live="polite"
      title={DESCRIPTION[status]}
      style={style}
    >
      <span aria-hidden className="sui-status-dot" />
      {LABEL[status] ?? status}
    </Badge>
  );
}

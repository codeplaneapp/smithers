/** @jsxImportSource react */
import { useInsertionEffect, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { Button, type ButtonProps } from "@smthrs/ui";
import { ensureGatewayUiStyles } from "./theme";

/**
 * The path the Gateway mounts the Smithers Monitor at. A served workflow UI page
 * (`/workflows/<key>`) is same-origin with the Gateway, so a link to this path
 * opens the Monitor without needing a configured base URL. Mirrors the CLI's
 * `MONITOR_UI_MOUNT_PATH`.
 */
export const DEFAULT_MONITOR_PATH = "/monitor";

export type MonitorHrefOptions = {
  /** Mount path of the Monitor on the Gateway. Default {@link DEFAULT_MONITOR_PATH}. */
  monitorPath?: string;
  /**
   * Origin the Monitor is served from. Defaults to the current page origin (the
   * Gateway serves both `/workflows/<key>` and `/monitor`, so they share one),
   * or an empty string for a relative link when there is no browser origin.
   */
  baseUrl?: string;
};

/**
 * Resolve the Monitor URL, deep-linking `runId` via `?runId=` exactly as the
 * `smithers monitor <runId>` CLI does (the Monitor reads `?runId` from
 * `location.search`). Same-origin and relative-safe: with no `baseUrl` and no
 * browser origin it yields `"/monitor"`.
 */
export function monitorHref(runId?: string, options: MonitorHrefOptions = {}): string {
  const path = options.monitorPath ?? DEFAULT_MONITOR_PATH;
  const origin = options.baseUrl ?? (typeof globalThis.location !== "undefined" ? globalThis.location.origin : "");
  const base = `${origin}${path}`;
  return runId ? `${base}?runId=${encodeURIComponent(runId)}` : base;
}

export type MonitorButtonProps = MonitorHrefOptions & {
  /** Deep-link this run when the Monitor opens (`?runId=`). */
  runId?: string;
  /** Button label. Defaults to "Open Monitor". */
  children?: ReactNode;
  /** Open the Monitor in a new tab (default true) so the workflow UI stays put. */
  newTab?: boolean;
  /** `Button` variant to compose (default "outline"). */
  variant?: ButtonProps["variant"];
  /** `Button` size to compose (default "sm"). */
  size?: ButtonProps["size"];
  className?: string;
  style?: CSSProperties;
  /** Extra anchor props (e.g. `onClick`, `title`). */
  anchorProps?: Omit<ComponentProps<"a">, "href" | "children" | "className" | "style">;
};

/**
 * A button that opens the Smithers Monitor — the live all-runs control surface
 * the Gateway serves at `/monitor` — deep-linked to `runId`. Rendered as an
 * anchor styled through the shipped {@link Button} so it is a real, accessible
 * link (middle-click / open-in-new-tab work). Include it in a workflow UI header
 * so operators can jump from one workflow's UI to the full run fleet.
 *
 * @example
 * <MonitorButton runId={runId} />
 */
export function MonitorButton({
  runId,
  monitorPath,
  baseUrl,
  children,
  newTab = true,
  variant = "outline",
  size = "sm",
  className,
  style,
  anchorProps,
}: MonitorButtonProps) {
  useInsertionEffect(ensureGatewayUiStyles, []);
  const href = monitorHref(runId, { monitorPath, baseUrl });
  return (
    <Button asChild variant={variant} size={size}>
      <a
        href={href}
        className={["gw-monitor-button", className].filter(Boolean).join(" ")}
        data-slot="monitor-button"
        data-run-id={runId}
        style={style}
        {...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        {...anchorProps}
      >
        {children ?? "Open Monitor"}
      </a>
    </Button>
  );
}

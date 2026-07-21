/** @jsxImportSource react */
import { createContext, useContext, useId, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "../cn";
import { EmptyState } from "../empty-state";
import { useInjectLaneCss } from "../internal/useInjectLaneCss";
import { formatStatus } from "../status";
import { StatusPill } from "../status-pill";
import { useInjectUiCss } from "../styles";
import { SANDBOX_CSS_ID, sandboxCss } from "./sandboxCss";

export type SandboxState = "provisioning" | "ready" | "disconnected" | "suspended" | "failed" | "destroyed";

/** Map sandbox lifecycle states onto the shared status vocabulary. */
export function sandboxStateToStatus(state: SandboxState): string {
  switch (state) {
    case "provisioning":
      return "pending";
    case "ready":
      return "ready";
    case "disconnected":
      return "waiting";
    case "suspended":
      return "paused";
    case "failed":
      return "failed";
    case "destroyed":
      return "cancelled";
  }
}

type AgentSandboxContextValue = {
  state: SandboxState;
  workspace?: string;
  repository?: string;
  open: boolean;
  triggerId: string;
  contentId: string;
};

const AgentSandboxContext = createContext<AgentSandboxContextValue | null>(null);

export type AgentSandboxProps = Omit<ComponentProps<"div">, "children"> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  state: SandboxState;
  workspace?: string;
  repository?: string;
  children?: ReactNode;
};

const STATE_EMPTY: Record<Exclude<SandboxState, "ready">, { title: string; description: string }> = {
  provisioning: { title: "Sandbox is provisioning", description: "The sandbox environment is being set up." },
  disconnected: { title: "Sandbox disconnected", description: "The connection to the sandbox was lost." },
  suspended: { title: "Sandbox suspended", description: "The sandbox is paused and can be reconnected." },
  failed: { title: "Sandbox failed", description: "The sandbox environment failed to start." },
  destroyed: { title: "Sandbox destroyed", description: "The sandbox environment has been torn down." },
};

/**
 * Collapsible sandbox environment unit: lifecycle state plus workspace /
 * repository identity. Never fabricates execution output — content renders
 * only what props provide, and non-ready states explain themselves through an
 * EmptyState.
 */
export function AgentSandbox({
  state,
  workspace,
  repository,
  open: controlledOpen,
  defaultOpen = true,
  onOpenChange,
  className,
  children,
  ...props
}: AgentSandboxProps) {
  useInjectUiCss();
  useInjectLaneCss(SANDBOX_CSS_ID, sandboxCss);
  const triggerId = useId();
  const contentId = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  function toggle() {
    const next = !open;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  return (
    <div
      data-slot="agent-sandbox"
      data-state={open ? "open" : "closed"}
      data-sandbox-state={state}
      className={cn("sui-sandbox", className)}
      {...props}
    >
      <AgentSandboxContext.Provider value={{ state, workspace, repository, open, triggerId, contentId }}>
        <button
          type="button"
          id={triggerId}
          data-slot="agent-sandbox-trigger"
          className="sui-sandbox-trigger"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={toggle}
        >
          <span className="sui-sandbox-chevron" aria-hidden="true">›</span>
          <span>Sandbox</span>
        </button>
        {children ?? (
          <>
            <AgentSandboxHeader>
              <AgentSandboxStatus state={state} />
            </AgentSandboxHeader>
            <AgentSandboxContent />
          </>
        )}
      </AgentSandboxContext.Provider>
    </div>
  );
}

export function AgentSandboxHeader({ className, children, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  useInjectLaneCss(SANDBOX_CSS_ID, sandboxCss);
  const ctx = useContext(AgentSandboxContext);
  return (
    <div data-slot="agent-sandbox-header" className={cn("sui-sandbox-header", className)} {...props}>
      {ctx && (ctx.workspace !== undefined || ctx.repository !== undefined) ? (
        <span className="sui-sandbox-identity">
          {ctx.repository !== undefined ? (
            <span data-slot="agent-sandbox-repository" className="sui-sandbox-repository">{ctx.repository}</span>
          ) : null}
          {ctx.workspace !== undefined ? (
            <span data-slot="agent-sandbox-workspace" className="sui-sandbox-workspace">{ctx.workspace}</span>
          ) : null}
        </span>
      ) : null}
      {children}
    </div>
  );
}

export type AgentSandboxStatusProps = Omit<ComponentProps<"span">, "children"> & {
  state: SandboxState;
};

export function AgentSandboxStatus({ state, className, ...props }: AgentSandboxStatusProps) {
  useInjectUiCss();
  useInjectLaneCss(SANDBOX_CSS_ID, sandboxCss);
  return (
    <StatusPill
      status={sandboxStateToStatus(state)}
      label={formatStatus(state)}
      data-slot="agent-sandbox-status"
      data-sandbox-state={state}
      className={cn("sui-sandbox-status", className)}
      {...props}
    />
  );
}

export type AgentSandboxActionsProps = Omit<ComponentProps<"div">, "children"> & {
  onRetry?: () => void;
  onReconnect?: () => void;
  children?: ReactNode;
};

export function AgentSandboxActions({ onRetry, onReconnect, className, children, ...props }: AgentSandboxActionsProps) {
  useInjectUiCss();
  useInjectLaneCss(SANDBOX_CSS_ID, sandboxCss);
  const ctx = useContext(AgentSandboxContext);
  const showRetry = onRetry !== undefined && (ctx === null || ctx.state === "failed");
  const showReconnect =
    onReconnect !== undefined && (ctx === null || ctx.state === "disconnected" || ctx.state === "suspended");
  return (
    <div
      data-slot="agent-sandbox-actions"
      role="group"
      aria-label="Sandbox actions"
      className={cn("sui-sandbox-actions", className)}
      {...props}
    >
      {showRetry ? (
        <button type="button" data-slot="agent-sandbox-retry" className="sui-sandbox-action" onClick={onRetry}>
          Retry
        </button>
      ) : null}
      {showReconnect ? (
        <button type="button" data-slot="agent-sandbox-reconnect" className="sui-sandbox-action" onClick={onReconnect}>
          Reconnect
        </button>
      ) : null}
      {children}
    </div>
  );
}

export function AgentSandboxContent({ className, children, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  useInjectLaneCss(SANDBOX_CSS_ID, sandboxCss);
  const ctx = useContext(AgentSandboxContext);
  if (ctx !== null && !ctx.open) return null;
  const empty = ctx !== null && ctx.state !== "ready" ? STATE_EMPTY[ctx.state] : null;
  return (
    <div
      data-slot="agent-sandbox-content"
      role="region"
      id={ctx?.contentId}
      aria-labelledby={ctx?.triggerId}
      className={cn("sui-sandbox-content", className)}
      {...props}
    >
      {children ?? (empty ? <EmptyState title={empty.title} description={empty.description} /> : null)}
    </div>
  );
}

/** @jsxImportSource react */
import type { ReactNode } from "react";
import { workflowUiStyles, workflowUiThemeCss } from "./styleguide-css";

export { workflowUiLayoutCss, workflowUiStyles, workflowUiThemeCss } from "./styleguide-css";

export type WorkflowUiStylesProps = {
  mode?: "theme" | "full";
  extra?: string;
  extraPlacement?: "before" | "after";
};

export function composeWorkflowUiStyles({
  mode = "full",
  extra,
  extraPlacement = "after",
}: WorkflowUiStylesProps = {}): string {
  const base = mode === "theme" ? workflowUiThemeCss : workflowUiStyles;
  if (!extra) return base;
  return extraPlacement === "before" ? [extra, base].join("\n") : [base, extra].join("\n");
}

export function WorkflowUiStyles(props: WorkflowUiStylesProps) {
  return <style>{composeWorkflowUiStyles(props)}</style>;
}

export type WorkflowUiShellProps = {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
};

export function WorkflowUiShell({ title, meta, actions, children, testId }: WorkflowUiShellProps) {
  return (
    <main className="workflow-shell" data-testid={testId}>
      <WorkflowUiStyles />
      <header className="topbar">
        <div className="title-group">
          <h1>{title}</h1>
          {meta}
        </div>
        {actions ? <div className="toolbar">{actions}</div> : null}
      </header>
      <div className="workflow-content">{children}</div>
    </main>
  );
}

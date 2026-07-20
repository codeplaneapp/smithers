/** @jsxImportSource react */
import type { CSSProperties } from "react";
import { useGatewayWorkflows } from "@smithers-orchestrator/gateway-react";
import { theme } from "./theme";

export type WorkflowPickerProps = {
  /** The selected workflow key. */
  value?: string;
  /** Called when a workflow is chosen. */
  onChange?: (workflowKey: string) => void;
  /** Only list workflows that have a custom UI mounted. */
  hasUiOnly?: boolean;
  className?: string;
  style?: CSSProperties;
};

type WorkflowRow = { key: string; readableName?: string };

/**
 * A `<select>` of the workflows registered on the gateway. Reads
 * {@link useGatewayWorkflows}. Pair with {@link LaunchButton} to build a launcher.
 */
export function WorkflowPicker({
  value,
  onChange,
  hasUiOnly = false,
  className,
  style,
}: WorkflowPickerProps) {
  const { data } = useGatewayWorkflows(hasUiOnly ? { filter: { hasUi: true } } : undefined);
  const workflows = (data ?? []) as WorkflowRow[];

  return (
    <select
      className={className}
      value={value ?? ""}
      onChange={(e) => onChange?.(e.target.value)}
      style={{
        padding: "8px 10px",
        borderRadius: theme.radius,
        border: `1px solid ${theme.border}`,
        background: theme.panel,
        color: theme.text,
        fontFamily: theme.fontSans,
        fontSize: 13,
        ...style,
      }}
    >
      <option value="" disabled>
        Select a workflow…
      </option>
      {workflows.map((wf) => (
        <option key={wf.key} value={wf.key}>
          {wf.readableName ?? wf.key}
        </option>
      ))}
    </select>
  );
}

export type WorkflowViewKind = "ui" | "tui";

export type WorkflowLiteralViewNode =
  | string
  | number
  | null
  | WorkflowLiteralViewNode[]
  | {
      type: string;
      props?: Record<string, unknown>;
      children?: WorkflowLiteralViewNode[];
    };

export type WorkflowViewDefinition = {
  kind: WorkflowViewKind;
  title?: string;
  props?: Record<string, unknown>;
  entry?: string;
  path?: string;
  source?: string;
  exportName?: string;
  literal?: WorkflowLiteralViewNode;
};

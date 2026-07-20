import type React from "react";

export type WorkflowViewBootProps = Record<string, unknown>;

export type WorkflowViewProps = {
  /**
   * Browser/TUI entry module to render for this workflow. Relative paths are
   * resolved from the workflow source file when the gateway registered it with
   * `entryFile`.
   */
  entry?: string;
  /**
   * Browser-safe module containing a React component export. This is for
   * advanced clients; importing the workflow module itself is usually wrong
   * because workflow modules can open DBs and import Node/Bun-only code.
   */
  source?: string;
  /** Export name from `source`. Defaults to `default` only when `source` is set. */
  exportName?: string;
  /** URL path for `<UI>`; ignored by `<TUI>`. Defaults to `/workflows/<key>`. */
  path?: string;
  title?: string;
  /** JSON-serializable boot props passed to the client React app. */
  props?: WorkflowViewBootProps;
  /**
   * Literal intrinsic React elements for the POC inline path. Function
   * components and event handlers are intentionally rejected by the gateway
   * serializer; use `entry`/`source` for interactive apps.
   */
  children?: React.ReactNode;
};

export type UIProps = WorkflowViewProps;
export type TUIProps = Omit<WorkflowViewProps, "path">;

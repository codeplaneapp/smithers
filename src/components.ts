import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { markdownComponents } from "./mdx-components";
import { zodSchemaToJsonExample } from "./zod-to-example";
import type {
  WorkflowProps,
  TaskProps,
  SequenceProps,
  ParallelProps,
  BranchProps,
  RalphProps,
  WorktreeProps,
} from "./types";
export function Workflow(props: WorkflowProps) {
  return React.createElement("smithers:workflow", props, props.children);
}

/**
 * Render JSX children to plain markdown text.
 *
 * If children is a React element (e.g. a compiled MDX component), we inject
 * `markdownComponents` via the standard MDX `components` prop so that
 * renderToStaticMarkup outputs clean markdown instead of HTML.
 * No HTML tag stripping or entity decoding needed.
 */
function renderChildrenToText(children: any): string {
  if (children == null) return "";
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  try {
    let element: React.ReactElement;
    if (React.isValidElement(children)) {
      // Inject markdown components into the element so MDX components
      // render fragments instead of HTML tags.
      element = React.cloneElement(children as React.ReactElement<any>, {
        components: markdownComponents,
      });
    } else {
      element = React.createElement(React.Fragment, null, children);
    }
    return renderToStaticMarkup(element)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch {
    return String(children ?? "");
  }
}

export function Task<Row>(props: TaskProps<Row>) {
  const { children, agent, ...rest } = props as any;
  if (agent) {
    // Auto-inject `schema` prop into React element children when outputSchema is present
    let childElement = children;
    if (React.isValidElement(children) && props.outputSchema) {
      childElement = React.cloneElement(children as React.ReactElement<any>, {
        schema: zodSchemaToJsonExample(props.outputSchema),
      });
    }
    const prompt = renderChildrenToText(childElement);
    return React.createElement(
      "smithers:task",
      { ...rest, agent, __smithersKind: "agent" },
      prompt,
    );
  }
  const nextProps = {
    ...rest,
    __smithersKind: "static",
    __smithersPayload: children,
    __payload: children,
  } as any;
  return React.createElement("smithers:task", nextProps, null);
}

export function Sequence(props: SequenceProps) {
  if (props.skipIf) return null;
  return React.createElement("smithers:sequence", props, props.children);
}

export function Parallel(props: ParallelProps) {
  if (props.skipIf) return null;
  return React.createElement("smithers:parallel", props, props.children);
}

export function Branch(props: BranchProps) {
  if (props.skipIf) return null;
  const chosen = props.if ? props.then : (props.else ?? null);
  return React.createElement("smithers:branch", props, chosen);
}

export function Ralph(props: RalphProps) {
  if (props.skipIf) return null;
  return React.createElement("smithers:ralph", props, props.children);
}

export function Worktree(props: WorktreeProps) {
  if (!props.path || !String(props.path).trim()) {
    throw new Error("<Worktree> requires a non-empty path prop");
  }
  if (props.skipIf) return null;
  return React.createElement("smithers:worktree", props, props.children);
}

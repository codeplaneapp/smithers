/** @jsxImportSource react */
import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { useInjectLaneCss } from "../internal/useInjectLaneCss";
import { CodeBlock } from "../primitives/CodeBlock";
import { formatJsonSafe } from "../agentic/formatJsonSafe";
import { CODING_ARTIFACTS_CSS_ID, artifactsCss } from "./artifactsCss";

export type SchemaDisplayProps = Omit<ComponentProps<"div">, "children"> & {
  schema: unknown;
  name?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

type JsonSchemaObject = {
  type?: unknown;
  properties?: unknown;
  required?: unknown;
  description?: unknown;
  items?: unknown;
  enum?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaTypeOf(schema: JsonSchemaObject): string {
  if (typeof schema.type === "string") {
    if (schema.type === "array" && isRecord(schema.items)) {
      return `array<${schemaTypeOf(schema.items as JsonSchemaObject)}>`;
    }
    return schema.type;
  }
  if (Array.isArray(schema.enum)) return "enum";
  if (isRecord(schema.properties)) return "object";
  return "unknown";
}

function SchemaPropertyList({ schema }: { schema: JsonSchemaObject }) {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((v): v is string => typeof v === "string") : [],
  );
  const entries = Object.entries(properties);
  return (
    <dl className="sui-schema-list">
      {entries.map(([propName, propSchema]) => {
        const prop: JsonSchemaObject = isRecord(propSchema) ? propSchema : {};
        const nested = isRecord(prop.properties);
        const description = typeof prop.description === "string" ? prop.description : undefined;
        return (
          <div className="sui-schema-row" key={propName}>
            <dt className="sui-schema-name">
              {propName}
              {required.has(propName) ? (
                <span className="sui-schema-required" aria-label="required" title="required">
                  *
                </span>
              ) : null}
            </dt>
            <dd className="sui-schema-type">{schemaTypeOf(prop)}</dd>
            {description !== undefined ? <dd className="sui-schema-description">{description}</dd> : null}
            {nested ? (
              <dd style={{ flexBasis: "100%", margin: 0 }}>
                <SchemaPropertyList schema={prop} />
              </dd>
            ) : null}
          </div>
        );
      })}
    </dl>
  );
}

/**
 * JSON-Schema renderer: object schemas become a nested definition list
 * (name, type, required marker, description); anything else falls back to a
 * CodeBlock of the raw JSON. Collapsible; defaultOpen true.
 */
export function SchemaDisplay({
  schema,
  name,
  open: controlledOpen,
  defaultOpen = true,
  onOpenChange,
  className,
  ...props
}: SchemaDisplayProps) {
  useInjectUiCss();
  useInjectLaneCss(CODING_ARTIFACTS_CSS_ID, artifactsCss);
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

  const isObjectSchema = isRecord(schema) && (schema.type === "object" || isRecord(schema.properties)) && isRecord((schema as JsonSchemaObject).properties);
  let body: ReactNode;
  if (isObjectSchema) {
    body = <SchemaPropertyList schema={schema as JsonSchemaObject} />;
  } else {
    body = <CodeBlock code={formatJsonSafe(schema)} language="json" showCopy={false} />;
  }

  return (
    <div
      data-slot="schema-display"
      data-state={open ? "open" : "closed"}
      className={cn("sui-schema", className)}
      {...props}
    >
      <button
        type="button"
        id={triggerId}
        data-slot="schema-display-trigger"
        className="sui-schema-trigger"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={toggle}
      >
        {name ?? "Schema"}
      </button>
      {open ? (
        <div
          data-slot="schema-display-content"
          id={contentId}
          role="region"
          aria-labelledby={triggerId}
          className="sui-schema-content"
        >
          {body}
        </div>
      ) : null}
    </div>
  );
}

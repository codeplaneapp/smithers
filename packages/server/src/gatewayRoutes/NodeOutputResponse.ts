export type NodeOutputResponse = {
  status: "produced" | "pending" | "failed";
  row: Record<string, unknown> | null;
  schema: {
    fields: Array<{
      name: string;
      type: "string" | "number" | "boolean" | "object" | "array" | "null" | "unknown";
      optional: boolean;
      nullable: boolean;
      description?: string;
      enum?: readonly unknown[];
    }>;
  } | null;
  partial?: Record<string, unknown> | null;
  /**
   * Why the node failed (from the latest attempt's stored error), present only
   * when `status` is "failed" and an error was recorded.
   */
  error?: {
    name?: string;
    code?: string;
    message: string;
    attempt?: number;
  } | null;
};

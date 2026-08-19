import type { ZodType } from "zod";

/**
 * What a wrapper schema's `validate` resolves to. It reports failure instead
 * of throwing, so callers must unwrap `value` before handing arguments to a
 * tool.
 */
export type ToolValidationResult<Input = unknown> =
  | { readonly success: true; readonly value: Input }
  | { readonly success: false; readonly error?: unknown };
export type ToolSchema<Input = unknown> =
  | ZodType<Input>
  | {
      readonly jsonSchema: Record<string, unknown>;
      readonly validate?: (value: unknown) => Promise<ToolValidationResult<Input>>;
    };
export type Tool<Input = unknown, Output = unknown> = {
  description?: string;
  inputSchema: ToolSchema<Input>;
  execute?: (
    input: Input,
    options?: { abortSignal?: AbortSignal; toolCallId?: string; messages?: ReadonlyArray<unknown> },
  ) => Output | Promise<Output>;
};
export type ToolSet = Record<string, Tool<any, any>>;

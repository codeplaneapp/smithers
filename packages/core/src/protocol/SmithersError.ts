import type { SmithersErrorCode } from "./errors/index";

export type SmithersError = {
  code: SmithersErrorCode;
  message: string;
  summary: string;
  docsUrl: string;
  details?: Record<string, unknown>;
  cause?: unknown;
};

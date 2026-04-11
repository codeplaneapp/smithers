export type SmithersErrorCode = string;

export class SmithersError extends Error {
  readonly code: SmithersErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: SmithersErrorCode,
    message: string,
    details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SmithersError";
    this.code = code;
    this.details = details;
  }
}

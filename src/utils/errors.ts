export class SmithersError extends Error {
  code: string;
  details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function isSmithersError(err: unknown): err is SmithersError {
  return Boolean(err && typeof err === "object" && (err as any).code);
}

export function errorToJson(err: unknown) {
  if (err instanceof Error) {
    const anyErr = err as any;
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      cause: anyErr?.cause,
      code: anyErr?.code,
      details: anyErr?.details,
    };
  }
  if (err && typeof err === "object") {
    return err;
  }
  return { message: String(err) };
}

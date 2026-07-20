export class GatewayRpcError extends Error {
  readonly code: string;
  readonly method: string;
  readonly status?: number;
  readonly requiredScope?: string;
  readonly refresh?: string;
  readonly details?: unknown;

  constructor(input: {
    method: string;
    code: string;
    message: string;
    status?: number;
    requiredScope?: string;
    refresh?: string;
    details?: unknown;
  }) {
    super(input.message);
    this.name = "GatewayRpcError";
    this.method = input.method;
    this.code = input.code;
    this.status = input.status;
    this.requiredScope = input.requiredScope;
    this.refresh = input.refresh;
    this.details = input.details;
  }
}
